/**
 * 统一 API 客户端
 * ================
 *
 * 两个职责：
 *
 * 1. **身份**：浏览器首次打开时生成一个 32 字节随机 token 存进 localStorage，
 *    之后每个请求都用 `Authorization: Bearer <token>` 带上。
 *    服务端只保存它的 sha256，拿不到 token 本身，因此谁也无法冒充别人。
 *    token 一旦丢失（清了浏览器数据）就无法找回 —— 这是「只存浏览器本地」的代价。
 *
 * 2. **模型凭据**：用户填的 baseUrl / apiKey / model 存在 localStorage，
 *    每次请求通过 `X-LLM-*` 头带给服务端，服务端用完即弃，不落盘、不打日志。
 */

export type LlmProtocol = 'openai' | 'codebuddy';

export interface LlmConfig {
  protocol: LlmProtocol;
  baseUrl: string;
  apiKey: string;
  model: string;
}

const TOKEN_KEY = 'novel.identity.token';
const LLM_KEY = 'novel.llm.config';

let tokenCache: string | null = null;

/* ============ 身份 ============ */

function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * 拿到（必要时生成）本机身份 token。
 * 首次会先问服务端能不能认领「本机所有者」身份（只有 127.0.0.1 且仅一次），
 * 认领成功就继承改造前的历史数据；否则生成全新身份。
 */
export async function ensureIdentity(): Promise<string> {
  if (tokenCache) return tokenCache;

  try {
    const stored = localStorage.getItem(TOKEN_KEY);
    if (stored && stored.length >= 32) {
      tokenCache = stored;
      return stored;
    }
  } catch {
    /* localStorage 不可用时退化为内存身份 */
  }

  try {
    const r = await fetch('/api/identity/claim-owner');
    if (r.ok) {
      const j = await r.json();
      if (j?.token) {
        tokenCache = j.token;
        localStorage.setItem(TOKEN_KEY, j.token);
        console.log('[Identity] 已继承本机历史数据');
        return j.token;
      }
    }
  } catch {
    /* 认领失败就走新身份 */
  }

  const fresh = randomToken();
  tokenCache = fresh;
  try {
    localStorage.setItem(TOKEN_KEY, fresh);
  } catch {
    /* ignore */
  }
  return fresh;
}

export function getIdentityToken(): string | null {
  if (tokenCache) return tokenCache;
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

/** 换一个新身份（旧数据仍在服务端，但当前浏览器不再指向它） */
export function resetIdentity(): void {
  tokenCache = null;
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* ignore */
  }
}

/* ============ 模型配置 ============ */

export function getLlm(): LlmConfig | null {
  try {
    const raw = localStorage.getItem(LLM_KEY);
    if (!raw) return null;
    const j = JSON.parse(raw);
    if (j?.protocol === 'codebuddy') return { protocol: 'codebuddy', baseUrl: '', apiKey: '', model: j.model || '' };
    if (j?.baseUrl && j?.apiKey && j?.model) {
      return { protocol: 'openai', baseUrl: j.baseUrl, apiKey: j.apiKey, model: j.model };
    }
  } catch {
    /* ignore */
  }
  return null;
}

export function setLlm(cfg: LlmConfig): void {
  try {
    localStorage.setItem(LLM_KEY, JSON.stringify(cfg));
  } catch {
    /* ignore */
  }
}

export function clearLlm(): void {
  try {
    localStorage.removeItem(LLM_KEY);
  } catch {
    /* ignore */
  }
}

/* ============ 请求 ============ */

export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const token = await ensureIdentity();
  const headers = new Headers(init.headers || {});
  headers.set('Authorization', `Bearer ${token}`);

  const llm = getLlm();
  if (llm) {
    headers.set('X-LLM-Protocol', llm.protocol);
    if (llm.baseUrl) headers.set('X-LLM-Base-Url', llm.baseUrl);
    if (llm.apiKey) headers.set('X-LLM-Key', llm.apiKey);
    if (llm.model) headers.set('X-LLM-Model', llm.model);
  }

  return fetch(path, { ...init, headers });
}

/** GET + JSON，失败抛错 */
export async function apiGet<T>(path: string): Promise<T> {
  const r = await apiFetch(path);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j as any)?.message || (j as any)?.error || `请求失败 (${r.status})`);
  return j as T;
}

/** POST + JSON，失败抛错 */
export async function apiPost<T>(path: string, body?: unknown): Promise<T> {
  const r = await apiFetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j as any)?.message || (j as any)?.error || `请求失败 (${r.status})`);
  return j as T;
}

export interface ProbeResult {
  ok: boolean;
  message: string;
  latencyMs?: number;
}

/** 测试一组模型配置能不能用（不带 header，直接用草稿） */
export async function testLlm(cfg: LlmConfig): Promise<ProbeResult> {
  const r = await apiFetch('/api/llm/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(cfg),
  });
  return (await r.json()) as ProbeResult;
}

/** 拉取该 key 下可用的模型列表 */
export async function fetchLlmModels(cfg: LlmConfig): Promise<string[]> {
  const r = await apiFetch('/api/llm/models', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(cfg),
  });
  const j = await r.json();
  if (!r.ok || !j?.ok) throw new Error(j?.message || '获取模型列表失败');
  return j.models || [];
}

/* ============ SSE 流（长任务：建书 / 存稿 / 降味） ============ */

export interface SseEvent {
  type?: 'progress' | 'done' | 'error' | string;
  [key: string]: any;
}

/**
 * POST 一个长任务并读取 SSE 事件流。
 *
 * 为什么不用普通 POST：
 *   建书 / 存稿要跑一两分钟。普通 POST 在这期间连接上没有任何字节，
 *   反向代理会判定连接已死直接掐断 —— 用户看到「请求失败」，服务端其实还在跑。
 *   SSE 服务端每 8 秒发一个心跳，连接始终活着，还能把进度实时推过来。
 *
 * 两个必须注意的点（否则长文本会被拆坏）：
 *   1. `decoder.decode(value, { stream: true })` —— 不带 stream:true 的话，
 *      跨数据包的中文会被解码成乱码；
 *   2. 拆行后要把最后一段没结束的残留留到下一轮 —— 直接 split('\n') 会把
 *      被拆成两个包的 JSON 事件截断，静默丢内容。
 */
export async function apiStream(
  path: string,
  body: unknown,
  onEvent: (evt: SseEvent) => void,
): Promise<void> {
  const r = await apiFetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify(body ?? {}),
  });

  if (!r.ok || !r.body) {
    const j = await r.json().catch(() => ({}));
    throw new Error((j as any)?.message || (j as any)?.error || `请求失败 (${r.status})`);
  }

  const reader = r.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    // 空闲看门狗：服务端每 8 秒会发一个 `: keep-alive` 注释，
    // 所以真的「一个字节都没有」超过 90 秒，就是连接死了 ——
    // 与其让界面永远转圈，不如明确断开并给出可操作的提示。
    let timer: ReturnType<typeof setTimeout> | undefined;
    const idle = new Promise<{ idle: true }>((resolve) => {
      timer = setTimeout(() => resolve({ idle: true }), 90_000);
    });
    const read = await Promise.race([reader.read(), idle]);
    clearTimeout(timer);
    if ((read as { idle?: true }).idle) {
      try {
        await reader.cancel();
      } catch {
        /* 连接已经断了，忽略 */
      }
      throw new Error('服务端 90 秒没有任何响应，已断开。请重试；若反复出现，检查「设置」里的模型配置是否可用。');
    }

    const { done, value } = read as ReadableStreamReadResult<Uint8Array>;
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      try {
        onEvent(JSON.parse(line.slice(6)));
      } catch {
        /* 半个事件，忽略 */
      }
    }
  }
}
