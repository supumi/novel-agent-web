/**
 * 统一的模型调用层
 * =================
 *
 * 支持两种协议，由用户在配置向导里选：
 *
 *  - `openai`    —— 任意 OpenAI 兼容接口（DeepSeek / 月之暗面 / 智谱 / OpenAI / 各种中转）。
 *                   `POST {baseUrl}/v1/chat/completions`，SSE 流式。
 *                   这是「把链接发给别人」后的默认方式：对方填自己的 key 就能用。
 *
 *  - `codebuddy` —— 走 CodeBuddy Agent SDK，用本机的登录态。
 *                   只对本机开发者有意义（发布出去的链接对方没有登录态）。
 *
 * 所有凭据都来自 `users.ts` 的请求上下文，**不落盘、不打日志**。
 *
 * ── 长文稳定性（这一层最重要的职责）──
 *  1. 显式传 max_tokens。不传的话很多网关默认 2048/4096，写长章节会被硬截断。
 *  2. 识别 finish_reason=length，自动接着往下写（续写轮次可配），并保证不重复。
 *  3. 网络抖动 / 429 / 5xx 自动重试，指数退避。
 *  4. 空响应视为失败并重试（有些中转会返回 200 但内容为空）。
 *  5. 支持并发映射（建书时并行拆调用用）。
 */

import type { LlmConfig } from './users.js';

/**
 * 注意：`@tencent-ai/agent-sdk` **不能**在模块顶层 import。
 *
 * 两个原因：
 *  1. 它带了原生二进制（native/ 下只有 win32-x64 / win32-arm64），
 *     在 Linux 沙箱里加载会直接抛错，把整个服务带崩；
 *  2. 它体积很大（~160MB），线上跑的又是 OpenAI 兼容协议，根本用不到。
 *
 * 所以：改成用到时再动态加载，并且**用变量做说明符** —— 这样 TypeScript
 * 不会去静态解析这个包，它被降级成 optionalDependencies 之后，
 * 即使线上没装上，编译和启动也不受任何影响。
 */
async function loadSdk(): Promise<any> {
  const specifier = '@tencent-ai/agent-sdk';
  return import(specifier);
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

/** 默认输出上限：一章 2000–3000 中文字 ≈ 3000–4500 token，给足余量 */
export const DEFAULT_MAX_TOKENS = 8192;

export interface StreamOptions {
  maxTokens?: number;
  temperature?: number;
  /** 拿到结束原因（stop / length / …），用于判断是否被截断 */
  onFinishReason?: (reason: string) => void;
}

/* ============ 地址补全 ============ */

/** 把用户填的 baseUrl 补全成 chat/completions 的完整地址 */
export function resolveChatUrl(baseUrl?: string): string {
  const base = (baseUrl || '').trim().replace(/\/+$/, '');
  if (!base) throw new Error('缺少 Base URL（例如 https://api.deepseek.com/v1）');
  if (/\/chat\/completions$/i.test(base)) return base;
  if (/\/v\d+$/i.test(base)) return `${base}/chat/completions`;
  return `${base}/v1/chat/completions`;
}

/** 把用户填的 baseUrl 补全成 models 列表地址 */
export function resolveModelsUrl(baseUrl?: string): string {
  const base = (baseUrl || '').trim().replace(/\/+$/, '');
  if (!base) throw new Error('缺少 Base URL');
  if (/\/models$/i.test(base)) return base;
  if (/\/v\d+$/i.test(base)) return `${base}/models`;
  return `${base}/v1/models`;
}

/** 对错误信息做脱敏：绝不让 key 出现在日志或前端 */
export function sanitizeError(msg: string, cfg?: LlmConfig): string {
  let out = msg || '未知错误';
  if (cfg?.apiKey && cfg.apiKey.length > 6) {
    out = out.split(cfg.apiKey).join('sk-***');
  }
  return out.slice(0, 500);
}

/* ============ 通用工具 ============ */

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 可重试的错误：限流 / 网关错误 / 网络抖动 */
function isRetryable(err: any): boolean {
  const msg = String(err?.message || err);
  if (/\b(429|500|502|503|504)\b/.test(msg)) return true;
  if (/rate.?limit|too many requests|overload|timeout|ETIMEDOUT|ECONNRESET|fetch failed|socket hang up/i.test(msg)) return true;
  return false;
}

/**
 * 并发映射：限制同时在飞的请求数。
 * 建书时会一次拆出 6–8 个子任务，全部并发容易被网关限流，
 * 这里既并发又限流，并在 429 时退避重试。
 */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * 把底层报错翻译成「用户能照着做」的中文。
 *
 * 最典型的一种：本机 CodeBuddy 登录。SDK 会拉起一个 CLI 边车，边车要监听
 * 127.0.0.1:56713 去拿 WorkBuddy 的凭据通道 —— 而 WorkBuddy 自己正占着这个端口。
 * 结果是 SDK 发一个 `{type:'error'}` 事件，然后**再也不发任何事件**。
 * 原始文案是 `listen EADDRINUSE: address already in use 127.0.0.1:56713`，
 * 对用户毫无意义，必须翻译。
 */
export function humanizeLlmError(msg: string): string {
  const m = msg || '未知错误';
  if (/EADDRINUSE/i.test(m)) {
    return (
      '本机 CodeBuddy 通道被占用（127.0.0.1:56713 已被 WorkBuddy / CodeBuddy 占用）。' +
      '请改用「API Key 接入」——DeepSeek、Kimi 等任意 OpenAI 兼容接口都行；' +
      '或在完全退出 WorkBuddy 后重试本机登录方式。'
    );
  }
  if (/EACCES|EPERM/i.test(m) && /listen|bind/i.test(m)) {
    return '本机 CodeBuddy 通道没有监听权限，请改用「API Key 接入」。';
  }
  if (/Cannot find package|MODULE_NOT_FOUND/i.test(m) && /agent-sdk/i.test(m)) {
    return '这台机器上没有可用的 CodeBuddy 运行环境，请改用「API Key 接入」。';
  }
  return m;
}

/**
 * 给异步迭代器套一个「多久没吐新内容就报错」的看门狗。
 *
 * 没有它，上游静默挂住（不报错也不返回）会让请求无限期悬着 ——
 * 用户看到的就是一个永远转圈的「正在生成…」，既没有结果也没有失败。
 * 宁可明确失败，也不要无限等待。
 */
async function* withIdleTimeout<T>(
  source: AsyncGenerator<T>,
  idleMs: number,
  label: string,
): AsyncGenerator<T> {
  let timer: any = null;
  const clear = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };
  try {
    while (true) {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label}超过 ${Math.round(idleMs / 1000)} 秒没有任何响应，已中断`)),
          idleMs,
        );
        if (timer?.unref) timer.unref();
      });
      let res: IteratorResult<T>;
      try {
        res = await Promise.race([source.next(), timeout]);
      } finally {
        clear();
      }
      if (res.done) return;
      yield res.value;
    }
  } finally {
    clear();
    // 提前退出（超时 / 抛错 / 调用方 break）时通知底层释放连接
    try {
      await source.return?.(undefined as any);
    } catch {
      /* 释放失败不影响主流程 */
    }
  }
}

/* ============ OpenAI 兼容协议 ============ */

interface OpenAICall {
  system: string;
  messages: ChatMessage[];
  opts: StreamOptions;
  /** 有些网关只认 max_completion_tokens（o1 系），失败时自动换一次 */
  useCompletionTokens?: boolean;
}

async function* streamOpenAI(cfg: LlmConfig, call: OpenAICall): AsyncGenerator<string> {
  if (!cfg.apiKey) throw new Error('缺少 API Key');
  const url = resolveChatUrl(cfg.baseUrl);
  const maxTokens = call.opts.maxTokens ?? DEFAULT_MAX_TOKENS;

  const body: Record<string, unknown> = {
    model: cfg.model,
    stream: true,
    messages: [
      ...(call.system ? [{ role: 'system', content: call.system }] : []),
      ...call.messages.map((m) => ({ role: m.role, content: m.content })),
    ],
  };
  if (call.useCompletionTokens) body.max_completion_tokens = maxTokens;
  else body.max_tokens = maxTokens;
  if (typeof call.opts.temperature === 'number') body.temperature = call.opts.temperature;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    // 换 max_completion_tokens 再试一次（o1 / 新版 OpenAI 网关）
    if (!call.useCompletionTokens && res.status === 400 && /max_completion_tokens|max_tokens/i.test(text)) {
      const retryCall: OpenAICall = { ...call, useCompletionTokens: true };
      yield* streamOpenAI(cfg, retryCall);
      return;
    }
    throw new Error(`模型接口返回 ${res.status}：${sanitizeError(text, cfg)}`);
  }
  if (!res.body) throw new Error('模型接口没有返回流式内容');

  const reader = (res.body as any).getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const raw of lines) {
      const line = raw.trim();
      if (!line || line.startsWith(':')) continue;
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') return;
      try {
        const json = JSON.parse(data);
        const choice = json?.choices?.[0];
        const piece = choice?.delta?.content ?? choice?.text ?? '';
        if (choice?.finish_reason && call.opts.onFinishReason) {
          call.opts.onFinishReason(String(choice.finish_reason));
        }
        if (piece) yield piece as string;
      } catch {
        /* 心跳或半包，跳过 */
      }
    }
  }
}

/* ============ CodeBuddy SDK 协议 ============ */

async function* streamCodebuddy(
  cfg: LlmConfig,
  system: string,
  messages: ChatMessage[],
  opts: StreamOptions,
): AsyncGenerator<string> {
  const sdk = await loadSdk();
  // SDK 只接受单条 prompt，这里把历史拼成一段带角色的对话文本
  const prompt =
    messages.length <= 1
      ? messages[0]?.content ?? ''
      : messages
          .map((m) => `${m.role === 'user' ? '【用户】' : '【助手】'}\n${m.content}`)
          .join('\n\n') + '\n\n【助手】';

  /**
   * SDK 会拉起一个 CodeBuddy 命令行边车，边车有时会去监听 127.0.0.1:56713
   * （WorkBuddy 的凭据通道）。WorkBuddy 自己开着时这个端口被占，
   * 边车就报 EADDRINUSE —— 但**这是随机的**：实测同一台机器上三次里有一次会撞。
   *
   * 所以这里重试。前提是「一个字都还没吐出去」：一旦已经 yield 过内容再重试，
   * 用户就会看到两段开头。
   */
  const maxAttempts = 4;
  let lastErr: any = null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const stream = sdk.query({
      prompt,
      options: {
        systemPrompt: system,
        tools: [],
        maxTurns: 1,
        persistSession: false,
        ...(cfg.model ? { model: cfg.model } : {}),
      },
    }) as any;

    let yielded = false;
    try {
      for await (const msg of stream) {
        if (msg?.type === 'assistant') {
          const content = msg.message?.content;
          if (typeof content === 'string') {
            yielded = true;
            yield content;
          } else if (Array.isArray(content)) {
            for (const block of content) {
              if (block?.type === 'text' && block.text) {
                yielded = true;
                yield block.text as string;
              }
            }
          }
        } else if (msg?.type === 'error') {
          // 必须**立刻**抛。原来是记进 errMsg、等循环结束后再抛，
          // 但 SDK 报完这个错就再也不发事件了 —— 循环永远不结束，
          // 错误永远抛不出来，用户只能看到一个永久转圈的界面。
          throw new Error(humanizeLlmError(msg.error || msg.message || 'SDK 错误'));
        } else if (msg?.type === 'result') {
          if (msg.is_error) {
            throw new Error(humanizeLlmError(typeof msg.result === 'string' ? msg.result : '模型返回错误'));
          } else if (opts.onFinishReason) opts.onFinishReason(String(msg.subtype || 'stop'));
        }
      }
      return; // 正常结束
    } catch (e: any) {
      lastErr = e;
      const conflict = /EADDRINUSE|通道被占用/.test(String(e?.message || ''));
      if (yielded || !conflict || attempt === maxAttempts - 1) throw e;
      const wait = 800 * (attempt + 1);
      console.warn(`[LLM] 本机 CodeBuddy 端口冲突（第 ${attempt + 1} 次），${wait}ms 后重试`);
      await sleep(wait);
    }
  }
  throw lastErr ?? new Error('本机 CodeBuddy 通道不可用');
}

/* ============ 对外统一入口 ============ */

/**
 * 空闲超时阈值。
 * CodeBuddy 是一次性返回整段（CLI 启动 + 推理都在等），要宽一些；
 * OpenAI 流式是一小片一小片吐，60 秒没动静基本就是死了。
 */
const IDLE_TIMEOUT_MS = { codebuddy: 240_000, openai: 90_000 } as const;

/** 流式对话：按协议分发 */
export function streamChat(
  cfg: LlmConfig,
  system: string,
  messages: ChatMessage[],
  opts: StreamOptions = {},
): AsyncGenerator<string> {
  const inner =
    cfg.protocol === 'codebuddy'
      ? streamCodebuddy(cfg, system, messages, opts)
      : streamOpenAI(cfg, { system, messages, opts });
  return withIdleTimeout(inner, IDLE_TIMEOUT_MS[cfg.protocol] ?? 120_000, '模型');
}

export interface CompleteResult {
  text: string;
  /** stop | length | … */
  finishReason: string;
  /** 实际发了几轮请求（>1 说明发生了自动续写） */
  rounds: number;
  truncated: boolean;
}

export interface CompleteOptions extends StreamOptions {
  label?: string;
  /** 被截断时最多自动续写几轮 */
  continueOnTruncate?: number;
  /** 期望最少字数，不足也会触发续写（中文正文字数） */
  minChars?: number;
  /** 网络类失败的重试次数 */
  retries?: number;
}

/**
 * 一次完整生成，内置「截断自动续写」。
 *
 * 这是「写长文不能崩」的核心：模型因为 max_tokens 用完而停下时，
 * 把已生成的内容作为 assistant 历史回填，再让它接着写，
 * 并明确禁止重复 —— 而不是把半截正文丢给用户。
 */
export async function completeRich(
  cfg: LlmConfig,
  system: string,
  messages: ChatMessage[],
  opts: CompleteOptions = {},
): Promise<CompleteResult> {
  const label = opts.label || 'complete';
  const maxRounds = Math.max(1, (opts.continueOnTruncate ?? 2) + 1);
  const retries = opts.retries ?? 2;
  const t0 = Date.now();

  const convo: ChatMessage[] = [...messages];
  let text = '';
  let finishReason = 'stop';
  let rounds = 0;

  for (let round = 0; round < maxRounds; round++) {
    let piece = '';
    let roundFinish = 'stop';

    let lastErr: any = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
      piece = '';
      try {
        for await (const chunk of streamChat(cfg, system, convo, {
          ...opts,
          onFinishReason: (r) => {
            roundFinish = r;
          },
        })) {
          piece += chunk;
        }
        if (piece.trim()) {
          lastErr = null;
          break;
        }
        lastErr = new Error('模型返回了空内容');
      } catch (e: any) {
        lastErr = e;
        if (!isRetryable(e) || attempt === retries) break;
        const wait = 800 * Math.pow(2, attempt);
        console.warn(`[LLM] ${label} 第 ${attempt + 1} 次失败（${sanitizeError(e?.message, cfg)}），${wait}ms 后重试`);
        await sleep(wait);
      }
    }

    if (lastErr && !piece.trim()) {
      // 前几轮已经有内容的话，不要因为最后一轮失败就整体失败
      if (text.trim()) break;
      throw new Error(sanitizeError(lastErr?.message || String(lastErr), cfg));
    }

    rounds++;
    text += piece;
    finishReason = roundFinish;

    const needMore =
      roundFinish === 'length' ||
      (typeof opts.minChars === 'number' && text.replace(/\s/g, '').length < opts.minChars);

    if (!needMore || round >= maxRounds - 1) break;

    // 回填已写内容，要求接着写
    convo.push({ role: 'assistant', content: piece });
    convo.push({
      role: 'user',
      content:
        '上一段到这里就断了。请**紧接着**继续写下去，从断点处直接续上，' +
        '不要重复已经写过的内容，不要重写开头，不要总结，不要加任何说明文字。' +
        (opts.minChars ? `还要再写至少 ${Math.max(400, opts.minChars - text.replace(/\s/g, '').length)} 字。` : ''),
    });
  }

  console.log(
    `[LLM] ${label}: ${Date.now() - t0}ms（${rounds} 轮，${text.length} 字，结束原因=${finishReason}）`,
  );
  return { text, finishReason, rounds, truncated: finishReason === 'length' };
}

/** 一次性拿完整文本（建书、大纲、回收、灵感都用它） */
export async function completeText(
  cfg: LlmConfig,
  system: string,
  user: string,
  opts: CompleteOptions = {},
): Promise<string> {
  const r = await completeRich(cfg, system, [{ role: 'user', content: user }], opts);
  return r.text;
}

/* ============ 配置校验 / 模型列表 ============ */

export interface ProbeResult {
  ok: boolean;
  message: string;
  models?: string[];
  latencyMs?: number;
}

/** 拉取可用模型列表 */
export async function listModels(cfg: LlmConfig): Promise<string[]> {
  if (cfg.protocol === 'codebuddy') {
    // 本机登录态：交给 SDK 自己报可用模型
    const sdk = await loadSdk();
    const session = await sdk.unstable_v2_createSession({ cwd: process.cwd() });
    const models = await session.getAvailableModels();
    return (models || []).map((m: any) => m.modelId || m.name).filter(Boolean);
  }
  const res = await fetch(resolveModelsUrl(cfg.baseUrl), {
    headers: { Authorization: `Bearer ${cfg.apiKey ?? ''}` },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`获取模型列表失败（${res.status}）：${sanitizeError(body, cfg)}`);
  }
  const json: any = await res.json();
  const arr = json?.data ?? json?.models ?? [];
  return arr.map((m: any) => m?.id || m?.modelId || m?.name).filter(Boolean);
}

/**
 * 真发一条最小请求验证 key 能用。
 * 「必须配置好一个模型才能用」这句话，靠的就是这个函数把门。
 */
export async function probeLlm(cfg: LlmConfig): Promise<ProbeResult> {
  const t0 = Date.now();
  if (cfg.protocol === 'openai') {
    if (!cfg.baseUrl) return { ok: false, message: '请填写 Base URL' };
    if (!cfg.apiKey) return { ok: false, message: '请填写 API Key' };
    if (!cfg.model) return { ok: false, message: '请选择或填写模型名' };
  }

  try {
    let text = '';
    for await (const piece of streamChat(
      cfg,
      '你是一个测试助手，只回答两个字：可用',
      [{ role: 'user', content: '请回复：可用' }],
      { maxTokens: 32 },
    )) {
      text += piece;
      if (text.length > 40) break; // 够证明通了，不再等
    }
    return {
      ok: true,
      message: text.trim() ? '连接成功' : '连接成功（模型没有返回文本，但接口可用）',
      latencyMs: Date.now() - t0,
    };
  } catch (e: any) {
    return { ok: false, message: sanitizeError(e?.message || String(e), cfg), latencyMs: Date.now() - t0 };
  }
}
