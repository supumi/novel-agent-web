/**
 * 多用户身份与数据隔离
 * ====================
 *
 * 对应需求：「把链接发给别人用，但每个人的数据互不可见，不泄露一点隐私」。
 *
 * 四条设计原则：
 *
 * 1. **身份由浏览器自己生成**。token = 32 字节随机数（localStorage 里存着），
 *    服务端只保存 `uid = sha256(token)[:32]`，**从不落盘 token 本身**，
 *    也无法从 uid 反推出 token。所以服务端拿不到任何可用于冒充用户的东西。
 *
 * 2. **一人一目录**。每个 uid 一个独立目录 `data/users/<uid>/`，
 *    聊天库 `chat.db` 和小说工程 `novel.json` 都在里面。
 *    路由层通过 `currentUser()` 取路径，代码里不存在「拿到别人目录」的入口。
 *
 * 3. **LLM 凭据只随请求走一趟**。apiKey / baseUrl / model 由前端放在请求头里，
 *    解析进内存上下文，转发给模型接口，**不写库、不写日志、不落盘**。
 *
 * 4. **老数据平滑迁移**。改造前是单用户版本（data/chat.db、data/novel.json）。
 *    首次启动时把它们搬进「本机所有者」目录，并只允许 127.0.0.1 认领一次，
 *    这样本机用户不会丢作品，远端访客也拿不到这份数据。
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * 数据根目录。
 * 默认是 novel-agent-web/data；可用 NOVEL_DATA_DIR 指到别处
 * （发布到线上时可以指到源码树之外，确保任何私人数据都不会被打包上传）。
 */
export const DATA_ROOT = process.env.NOVEL_DATA_DIR
  ? path.resolve(process.env.NOVEL_DATA_DIR)
  : path.join(__dirname, '..', 'data');
/** 所有用户目录的父目录 */
export const USERS_ROOT = path.join(DATA_ROOT, 'users');

const OWNER_TOKEN_FILE = path.join(USERS_ROOT, '.owner-token');
const LEGACY_CLAIMED_FILE = path.join(USERS_ROOT, '.legacy-claimed');

/** 老版本单用户模式遗留下来的文件 */
const LEGACY_FILES = ['chat.db', 'chat.db-wal', 'chat.db-shm', 'novel.json'];

/* ============ 类型 ============ */

/** 用户自己填的模型接口配置（只在内存中流转） */
export interface LlmConfig {
  /** openai = 任意 OpenAI 兼容接口；codebuddy = 本机 CodeBuddy 登录态 */
  protocol: 'openai' | 'codebuddy';
  baseUrl?: string;
  apiKey?: string;
  model: string;
}

export interface UserContext {
  uid: string;
  /** 该用户独占的数据目录 */
  dir: string;
  llm: LlmConfig;
}

/* ============ 上下文（AsyncLocalStorage） ============ */

const als = new AsyncLocalStorage<UserContext>();

/** 在指定用户上下文里执行后续逻辑（中间件里调用一次，全链路生效） */
export function runAsUser<T>(ctx: UserContext, fn: () => T): T {
  return als.run(ctx, fn);
}

/** 取当前请求的用户上下文；不在请求里（例如启动脚本）会抛错 */
export function currentUser(): UserContext {
  const ctx = als.getStore();
  if (!ctx) throw new Error('NO_USER_CONTEXT：该操作必须在已鉴权的请求上下文中执行');
  return ctx;
}

export function tryCurrentUser(): UserContext | null {
  return als.getStore() ?? null;
}

/* ============ 身份 ============ */

/** token → uid。单向散列，服务端无法从 uid 还原 token。 */
export function uidFromToken(token: string): string {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex').slice(0, 32);
}

/** 取该用户的目录（不存在则创建）。uid 严格校验，杜绝路径穿越。 */
export function userDir(uid: string): string {
  if (!/^[a-f0-9]{32}$/.test(uid)) throw new Error('BAD_UID：身份标识格式不合法');
  const dir = path.join(USERS_ROOT, uid);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** 生成一个新的身份 token（前端也会用同样的方式生成） */
export function newToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

/* ============ 从请求里解析身份与凭据 ============ */

function header(req: any, name: string): string | undefined {
  const v = req?.headers?.[name];
  const s = Array.isArray(v) ? v[0] : v;
  return typeof s === 'string' && s.trim() ? s.trim() : undefined;
}

/** 身份 token：Authorization: Bearer xxx，兼容 X-User-Token */
export function tokenFromRequest(req: any): string {
  const auth = header(req, 'authorization');
  if (auth && /^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, '').trim();
  return header(req, 'x-user-token') ?? '';
}

/** 模型凭据：从请求头解析，全程只存在于内存 */
export function llmFromRequest(req: any): LlmConfig {
  const protocol = header(req, 'x-llm-protocol');
  return {
    protocol: protocol === 'codebuddy' ? 'codebuddy' : 'openai',
    baseUrl: header(req, 'x-llm-base-url'),
    apiKey: header(req, 'x-llm-key'),
    model: header(req, 'x-llm-model') ?? '',
  };
}

/* ============ 启动引导 + 老数据迁移 ============ */

let ownerTokenCache: string | null = null;

function isLoopback(ip: string): boolean {
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1' || ip === 'localhost';
}

/**
 * 启动时执行：
 * - 建好目录骨架
 * - 为「本机所有者」准备一个稳定的 token
 * - 把老版本的单用户数据搬进所有者目录（仅一次）
 */
export function bootstrapUsers(): void {
  fs.mkdirSync(USERS_ROOT, { recursive: true });

  if (fs.existsSync(LEGACY_CLAIMED_FILE)) {
    console.log('[Users] 数据已按用户分区运行（所有者已认领）');
    return;
  }

  // 只有确实存在历史数据时才需要「所有者」这个概念。
  // 全新部署（例如发布出去的实例）不生成 owner token，也就没有任何可被认领的东西。
  const legacy = LEGACY_FILES.map((f) => path.join(DATA_ROOT, f)).filter((p) => fs.existsSync(p));
  if (legacy.length === 0) {
    console.log('[Users] 全新部署，无历史数据需要迁移');
    return;
  }

  // 复用或生成一个稳定的 owner token（重启后不变，保证迁移目标目录固定）
  let token = '';
  try {
    if (fs.existsSync(OWNER_TOKEN_FILE)) token = fs.readFileSync(OWNER_TOKEN_FILE, 'utf8').trim();
  } catch {
    /* ignore */
  }
  if (!/^[a-f0-9]{64}$/.test(token)) {
    token = newToken();
    fs.writeFileSync(OWNER_TOKEN_FILE, token, { encoding: 'utf8', mode: 0o600 });
  }
  ownerTokenCache = token;

  const uid = uidFromToken(token);
  const dir = userDir(uid);

  let moved = 0;
  for (const src of legacy) {
    const dst = path.join(dir, path.basename(src));
    if (fs.existsSync(dst)) continue; // 目标已有，不覆盖
    try {
      fs.renameSync(src, dst);
      moved += 1;
    } catch (e: any) {
      // 跨设备等情况退化为复制
      try {
        fs.copyFileSync(src, dst);
        fs.unlinkSync(src);
        moved += 1;
      } catch (e2: any) {
        console.error(`[Users] 迁移 ${path.basename(src)} 失败:`, e2?.message || e?.message);
      }
    }
  }
  console.log(
    `[Users] 已把历史单用户数据迁移到所有者目录 data/users/${uid}/（${moved}/${legacy.length} 个文件）`,
  );
}

/**
 * 本机所有者一次性认领入口。
 * 只有 127.0.0.1 的请求能拿到 token，且只成功一次；
 * 认领后立刻删除 token 文件，之后谁都无法再取。
 */
export function claimOwnerToken(req: any): { token: string; uid: string } | null {
  if (fs.existsSync(LEGACY_CLAIMED_FILE)) return null;

  const ip = req?.socket?.remoteAddress || req?.ip || '';
  if (!isLoopback(String(ip))) {
    console.warn(`[Users] 拒绝来自 ${ip} 的所有者认领请求（仅限本机）`);
    return null;
  }

  // 关键防线：如果部署在反向代理后面，remoteAddress 会是代理自己的地址（常常也是 127.0.0.1），
  // 这时 X-Forwarded-For 会带上真实访客 IP。只要它存在且不是本机，就一律拒绝。
  const xff = header(req, 'x-forwarded-for');
  if (xff) {
    const realIp = xff.split(',')[0].trim();
    if (!isLoopback(realIp)) {
      console.warn(`[Users] 拒绝代理转发而来的认领请求（真实来源 ${realIp}）`);
      return null;
    }
  }

  let token = ownerTokenCache;
  if (!token && fs.existsSync(OWNER_TOKEN_FILE)) {
    token = fs.readFileSync(OWNER_TOKEN_FILE, 'utf8').trim();
  }
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;

  const uid = uidFromToken(token);
  userDir(uid);
  fs.writeFileSync(LEGACY_CLAIMED_FILE, new Date().toISOString(), 'utf8');
  try {
    fs.unlinkSync(OWNER_TOKEN_FILE);
  } catch {
    /* ignore */
  }
  ownerTokenCache = null;
  console.log(`[Users] 本机所有者已认领历史数据（uid=${uid}），认领入口已关闭`);
  return { token, uid };
}

/** 该用户的目录里是否已经有作品（用于前端提示） */
export function hasAnyData(uid: string): boolean {
  try {
    const dir = userDir(uid);
    return fs.readdirSync(dir).length > 0;
  } catch {
    return false;
  }
}
