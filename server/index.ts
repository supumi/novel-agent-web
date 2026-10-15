import express from "express";
import { v4 as uuidv4 } from "uuid";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { createServer } from "net";
import * as db from "./db.js";
import novelRouter from "./novel.js";
import {
  bootstrapUsers,
  claimOwnerToken,
  currentUser,
  llmFromRequest,
  runAsUser,
  tokenFromRequest,
  uidFromToken,
  userDir,
} from "./users.js";
import { listModels, probeLlm, sanitizeError, streamChat } from "./llm.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/* ============ 启动引导 ============ */

// 1) 用户目录骨架 + 老数据迁移（必须在任何 db 打开之前执行）
bootstrapUsers();

// 2) CodeBuddy SDK 的内部服务需要一个监听端口，默认端口（56713）可能已被其它程序占用，
//    从而在 query() 时报 `listen EADDRINUSE`。
//    这里不信任 SERVER__PORT 的现值（宿主机环境可能已经设成了它自己占用的端口），
//    统一做一次「能否真正绑定」探测：能绑就用，不能绑就自动换一个空闲端口。
const desiredPort = Number(process.env.SERVER__PORT) || 56713;

async function isPortFree(port: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const probe = createServer();
    probe.once("error", () => resolve(false));
    probe.listen(port, "127.0.0.1", () => {
      probe.close(() => resolve(true));
    });
  });
}

async function pickFreePort(): Promise<number> {
  return new Promise<number>((resolve) => {
    const probe = createServer();
    probe.once("error", () => resolve(0));
    probe.listen(0, "127.0.0.1", () => {
      const addr = probe.address();
      const p = typeof addr === "object" && addr ? addr.port : 0;
      probe.close(() => resolve(p));
    });
  });
}

if (await isPortFree(desiredPort)) {
  process.env.SERVER__PORT = String(desiredPort);
  console.log(`[Boot] SDK 内部端口 ${desiredPort} 可用，直接使用`);
} else {
  const picked = await pickFreePort();
  if (picked) {
    process.env.SERVER__PORT = String(picked);
    console.log(`[Boot] 端口 ${desiredPort} 已被占用，已自动改用空闲端口 ${picked}`);
  } else {
    console.warn("[Boot] 未能自动挑选空闲端口，将沿用 SDK 默认端口");
  }
}

const app = express();
const PORT = Number(process.env.PORT || 3000);

app.use(express.json({ limit: "8mb" }));

/* ============ 身份 / 隔离中间件 ============ */

/**
 * 本机所有者一次性认领：把改造前的历史数据接管过来。
 * 只允许 127.0.0.1，且只成功一次。远端访客拿到的是 204，什么也拿不到。
 */
app.get("/api/identity/claim-owner", (req, res) => {
  const claimed = claimOwnerToken(req);
  if (!claimed) return res.status(204).end();
  res.json({ token: claimed.token, uid: claimed.uid, adopted: true });
});

/**
 * 除健康检查与认领入口外，所有 /api 请求都必须带身份 token。
 * 解析出的用户上下文塞进 AsyncLocalStorage，后续 db / novel 全部按 uid 分区。
 */
app.use("/api", (req, res, next) => {
  if (req.path === "/health" || req.path === "/identity/claim-owner") return next();

  const token = tokenFromRequest(req);
  if (!token || token.length < 16) {
    return res.status(401).json({
      error: "NO_IDENTITY",
      message: "缺少身份标识，请刷新页面完成初始化",
    });
  }

  const uid = uidFromToken(token);
  const ctx = { uid, dir: userDir(uid), llm: llmFromRequest(req) };
  runAsUser(ctx, () => next());
});

/* ============ 健康检查 ============ */

app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

/* ============ 小说工程 ============ */

// 建书 / 续写上下文 / 回收 / 一致性校验 / AI 痕迹体检 / 关系图谱
// 必须挂在鉴权中间件之后：所有读写都会按 currentUser().dir 落到各自的目录
app.use("/api/novel", novelRouter);

/* ============ 模型配置 ============ */

/** 当前请求头里带来的模型配置是否齐全 */
function llmReady(llm: { protocol: string; baseUrl?: string; apiKey?: string; model?: string }): boolean {
  if (llm.protocol === "codebuddy") return true;
  return Boolean(llm.baseUrl && llm.apiKey && llm.model);
}

/** 保存前的连通性测试：把门的就是它 —— 测通了才算「配置好一个模型」 */
app.post("/api/llm/test", async (req, res) => {
  const llm = llmFromRequest(req);
  const body = req.body || {};
  // 允许前端在正式保存前先测一遍（用 body 里的草稿覆盖 header）
  const draft = {
    protocol: (body.protocol || llm.protocol) as "openai" | "codebuddy",
    baseUrl: body.baseUrl ?? llm.baseUrl,
    apiKey: body.apiKey ?? llm.apiKey,
    model: body.model ?? llm.model ?? "",
  };
  if (!llmReady(draft)) {
    return res.status(400).json({ ok: false, message: "请把 Base URL、API Key、模型名都填完再测试" });
  }
  const result = await probeLlm(draft);
  res.json(result);
});

/** 拉取该 key 下可用的模型列表，供下拉选择 */
app.post("/api/llm/models", async (req, res) => {
  const llm = llmFromRequest(req);
  const body = req.body || {};
  const draft = {
    protocol: (body.protocol || llm.protocol) as "openai" | "codebuddy",
    baseUrl: body.baseUrl ?? llm.baseUrl,
    apiKey: body.apiKey ?? llm.apiKey,
    model: body.model ?? llm.model ?? "",
  };
  try {
    const models = await listModels(draft);
    res.json({ ok: true, models });
  } catch (e: any) {
    res.status(400).json({ ok: false, message: sanitizeError(e?.message || String(e), draft) });
  }
});

/**
 * 本机是否具备 CodeBuddy 登录态（决定配置向导要不要给出「本机登录」选项）。
 *
 * 两件事都要防：
 * 1. SDK 带的是 win32 原生二进制，Linux 上加载会抛错 —— 加载失败就当作「没有本机登录」。
 * 2. **加载成功不等于登录了。** 在服务器上（没登录过）它照样会返回一个真值对象，
 *    只是 `userName` 是 `anonymous`。原来的判断只看了 `Boolean(result)`，
 *    于是线上也报 isLoggedIn:true，向导就给访客摆出一个必然失败的「本机 CodeBuddy 登录」。
 *    所以必须要求一个真实用户名，并且排掉 anonymous。
 */
app.get("/api/check-login", async (_req, res) => {
  try {
    const specifier = "@tencent-ai/agent-sdk";
    const sdk: any = await import(specifier);
    let needsLogin = false;
    const result = await sdk.unstable_v2_authenticate({
      environment: "external",
      onAuthUrl: async () => {
        needsLogin = true;
      },
    });
    const userName: string | null = (result as any)?.userinfo?.userName ?? null;
    const anonymous = !userName || userName.toLowerCase() === "anonymous";
    const ok = !needsLogin && Boolean(result) && !anonymous;
    res.json({
      isLoggedIn: ok,
      method: ok ? "cli" : "none",
      userName: ok ? userName : null,
    });
  } catch (e: any) {
    console.log(`[Check Login] SDK 不可用（${e?.message || e}），按无本机登录处理`);
    res.json({ isLoggedIn: false, method: "none" });
  }
});

/** 可用模型（来自用户自己的 key） */
app.get("/api/models", async (req, res) => {
  const llm = llmFromRequest(req);
  if (!llmReady(llm)) return res.json({ models: [], defaultModel: null });
  try {
    const models = await listModels(llm);
    res.json({
      models: models.map((id) => ({ modelId: id, name: id })),
      defaultModel: llm.model || models[0] || null,
    });
  } catch (e: any) {
    res.json({
      models: llm.model ? [{ modelId: llm.model, name: llm.model }] : [],
      defaultModel: llm.model || null,
      error: sanitizeError(e?.message || String(e), llm),
    });
  }
});

/* ============ 会话 API（全部按当前用户分区） ============ */

app.get("/api/sessions", (_req, res) => {
  try {
    const sessions = db.getAllSessions();
    const withCount = sessions.map((s) => ({ ...s, messageCount: db.getMessagesBySession(s.id).length }));
    res.json({ sessions: withCount });
  } catch (error: any) {
    console.error("[Sessions] Error:", error?.message);
    res.status(500).json({ error: error?.message || "获取会话失败" });
  }
});

app.get("/api/sessions/:sessionId", (req, res) => {
  try {
    const { sessionId } = req.params;
    const session = db.getSession(sessionId);
    if (!session) return res.status(404).json({ error: "会话不存在" });

    const messages = db.getMessagesBySession(sessionId).map((msg) => ({
      ...msg,
      tool_calls: msg.tool_calls ? JSON.parse(msg.tool_calls) : null,
    }));
    res.json({ session, messages });
  } catch (error: any) {
    console.error("[Session] Error:", error?.message);
    res.status(500).json({ error: error?.message || "获取会话失败" });
  }
});

app.post("/api/sessions", (req, res) => {
  try {
    const { model = "", title = "新对话" } = req.body;
    const now = new Date().toISOString();
    const session = db.createSession({
      id: uuidv4(),
      title,
      model,
      sdk_session_id: null,
      created_at: now,
      updated_at: now,
    });
    res.json({ session });
  } catch (error: any) {
    console.error("[Create Session] Error:", error?.message);
    res.status(500).json({ error: error?.message || "创建会话失败" });
  }
});

app.patch("/api/sessions/:sessionId", (req, res) => {
  try {
    const { title, model } = req.body;
    if (!db.updateSession(req.params.sessionId, { title, model })) {
      return res.status(404).json({ error: "会话不存在" });
    }
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error?.message || "更新会话失败" });
  }
});

app.delete("/api/sessions/:sessionId", (req, res) => {
  try {
    if (!db.deleteSession(req.params.sessionId)) {
      return res.status(404).json({ error: "会话不存在" });
    }
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error?.message || "删除会话失败" });
  }
});

/** 保留：当前聊天链路已不使用工具，不会有权限请求 */
app.post("/api/permission-response", (_req, res) => {
  res.json({ success: true });
});

/* ============ 聊天 API ============ */

// 默认系统提示词：小说创作助手（面向 novel-forge 的方法论）
const defaultSystemPrompt = `你是「小说创作助手」——一位懂网文节奏、也懂怎么把 AI 味压下去的中文小说共创者。
你的目标不是写得多，而是写得像人写、接得住前文、埋得住坑、收得回线。

【写作铁律】
1. 写具体，不写感受。用物件、动作、生理反应、数字来呈现情绪，绝不直接命名情绪。
   反例：他很难过 / 他很愤怒。
   正例：他把烟摁灭在鞋底，蹭了两下。/ 他的手停在门把上，没拧。
2. 留白不等于总结。写完动作或对白就停，别补一句「他感到……」替读者下结论。
3. 给正例，不给禁令。调语感时先给一段真正像人的网文做示范，再让文字照着靠。
4. 砍抽象比喻。本体是抽象概念的比喻（「像在数着什么」）一律删；要比喻就落到具体物象。

【四层记忆】每次续写前先在脑内过一遍：
- canon 硬设定：世界规则、人物核心创伤与欲望。不可擅改，是地基。
- state 状态：人物此刻在哪、处境如何、时间线走到哪。每章更新。
- hooks 钩子：已埋未收的坑，带压力值。
- recent 近况：上一章原文尾部约 1200 字（保语感）+ 更早章节摘要。

【钩子压力】按「埋下后过了几章」计：
0 章 cold（刚埋，不急）｜1–2 章 warm（正常）｜3–4 章 due（本章该收）
｜5–6 章 overdue（拖太久，要提醒）｜7+ 章 rotten（该处理或放弃）。
规则：一章最多收两个坑；同时开着的钩子总量上限 8 个，超了先消化、禁止再埋新坑，优先收拖最久的。

【一致性自查】交稿前查这七类硬伤，致命级必须拦下：
① 死者复现（致命）② 伏笔挂在死人身上（致命）③ 双向从属（致命）④ 属性自相矛盾（致命）
⑤ 关系涉及死者（警告）⑥ 关系闭环（警告）⑦ 盟友/敌对不对称（警告）。
关系是有向的：A 恨 B ≠ B 恨 A，记 {from, to, kind, since, until}；角色死亡时其所有活跃关系自动关闭。

【AI 痕迹体检】交稿前自查：比喻本体是否抽象？情绪是否被直接命名？有没有排比式总结？
分档 obvious≥70 / suspect≥40 / mild≥15 / clean<15，目标 clean。

【工作方式】
- 给一句创意 → 先出简洁设定（canon + 主要人物），别一上来就写正文。
- 续写一章 → 先复述「本章要接的线 + 要收的钩子」，再给正文；正文末尾附一行「本章埋/收了哪些钩子」。
- 只有正文与既有设定发生矛盾时才停下来问用户，其余不要逐条确认。
- 默认输出中文正文 2000–3000 字。`;

app.post("/api/chat", async (req, res) => {
  const { sessionId, message, model, systemPrompt } = req.body;
  const { llm } = currentUser();

  console.log(`\n[Chat] ========== 新请求 ==========`);
  console.log(`[Chat] SessionId: ${sessionId}`);
  console.log(`[Chat] Model: ${model || llm.model}`);

  if (!message) return res.status(400).json({ error: "消息不能为空" });
  if (!llmReady(llm)) {
    return res.status(400).json({ error: "NO_MODEL", message: "还没有配置可用的模型，请先完成模型配置" });
  }

  // 获取或创建会话（都在当前用户自己的库里）
  let session = sessionId ? db.getSession(sessionId) : null;
  const now = new Date().toISOString();

  if (!session) {
    session = db.createSession({
      id: sessionId || uuidv4(),
      title: message.slice(0, 30) + (message.length > 30 ? "..." : ""),
      model: model || llm.model,
      sdk_session_id: null,
      created_at: now,
      updated_at: now,
    });
  }

  const selectedModel = model || llm.model;
  const userMessageId = uuidv4();
  const assistantMessageId = uuidv4();

  // 历史消息：用于替代 SDK 的 resume，把上下文拼回去
  const history = db
    .getMessagesBySession(session.id)
    .slice(-20)
    .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));

  try {
    db.createMessage({
      id: userMessageId,
      session_id: session.id,
      role: "user",
      content: message,
      model: null,
      created_at: now,
      tool_calls: null,
    });
  } catch (dbError: any) {
    console.error(`[Chat] 保存用户消息失败:`, dbError?.message);
    return res.status(500).json({ error: "保存消息失败", detail: dbError?.message });
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");

  // 首 token 可能要等很久（推理模型尤其），这期间连接完全静默，
  // 反向代理会当成死连接掐断。8 秒一个注释行把连接养着。
  const keepAlive = setInterval(() => {
    try {
      res.write(": keep-alive\n\n");
    } catch {
      /* 连接已断 */
    }
  }, 8000);
  res.on("close", () => clearInterval(keepAlive));

  res.write(
    `data: ${JSON.stringify({
      type: "init",
      sessionId: session.id,
      userMessageId,
      assistantMessageId,
      model: selectedModel,
    })}\n\n`,
  );

  const t0 = Date.now();
  let fullResponse = "";
  let truncated = false;
  let continueRounds = 0;
  try {
    const cfg = { ...llm, model: selectedModel };
    const sysPrompt = systemPrompt || defaultSystemPrompt;
    const convo: Array<{ role: "user" | "assistant"; content: string }> = [
      ...history,
      { role: "user", content: message },
    ];

    /**
     * 截断续写 —— 「写长文不能崩」的关键一环。
     *
     * 模型 max_tokens 用完时会以 finish_reason=length 停下，用户拿到的是半截正文，
     * 而且往往是在最紧张的地方断掉。这里检测到 length 就把本轮已生成的内容
     * 作为 assistant 历史回填，再让它紧接着往下写，最多补 2 轮。
     * 全程还在同一条 SSE 流里，前端体验是「一直往下写」，看不到断点。
     */
    const MAX_ROUNDS = 3; // 1 次正常 + 2 次续写
    for (let round = 0; round < MAX_ROUNDS; round++) {
      let piece = "";
      let finish = "stop";
      for await (const chunk of streamChat(cfg, sysPrompt, convo, {
        onFinishReason: (r) => {
          finish = r;
        },
      })) {
        piece += chunk;
        fullResponse += chunk;
        res.write(`data: ${JSON.stringify({ type: "text", content: chunk })}\n\n`);
      }

      if (finish !== "length" || round === MAX_ROUNDS - 1) {
        truncated = finish === "length";
        break;
      }

      continueRounds = round + 1;
      console.log(
        `[Chat] 第 ${round + 1} 轮被截断（已生成 ${fullResponse.length} 字），自动续写…`,
      );
      res.write(
        `data: ${JSON.stringify({ type: "continue", round: round + 1, chars: fullResponse.length })}\n\n`,
      );
      convo.push({ role: "assistant", content: piece });
      convo.push({
        role: "user",
        content:
          "上一段到这里就断了。请紧接着继续写下去，从断点处直接续上，" +
          "不要重复已经写过的内容，不要重写开头，不要总结，不要加任何说明文字。",
      });
    }

    db.createMessage({
      id: assistantMessageId,
      session_id: session.id,
      role: "assistant",
      content: fullResponse,
      model: selectedModel,
      created_at: new Date().toISOString(),
      tool_calls: null,
    });

    if (db.getMessagesBySession(session.id).length <= 2) {
      db.updateSession(session.id, {
        title: message.slice(0, 30) + (message.length > 30 ? "..." : ""),
        model: selectedModel,
      });
    }

    res.write(
      `data: ${JSON.stringify({
        type: "done",
        duration: Date.now() - t0,
        chars: fullResponse.length,
        truncated,
        continueRounds,
      })}\n\n`,
    );
    console.log(
      `[Chat] 请求完成 ✓ ${Date.now() - t0}ms / ${fullResponse.length} 字` +
        (continueRounds ? `（含 ${continueRounds} 轮续写）` : "") +
        (truncated ? " ⚠️ 仍被截断" : ""),
    );
    res.end();
  } catch (error: any) {
    const msg = sanitizeError(error?.message || String(error), llm);
    console.error(`[Chat] 错误: ${msg}`);
    res.write(`data: ${JSON.stringify({ type: "error", message: msg })}\n\n`);
    res.end();
  }
});

/* ============ 前端静态资源 ============ */

// 前端产物目录（vite.config.ts 里配的 outDir）
const distDir = path.join(__dirname, "..", "web");
if (fs.existsSync(distDir)) {
  app.use(express.static(distDir));
  // SPA 兜底：非 /api 路径一律交给前端路由
  app.get(/^(?!\/api).*/, (_req, res) => {
    res.sendFile(path.join(distDir, "index.html"));
  });
  console.log(`[Boot] 已托管前端构建产物: ${distDir}`);
} else {
  console.log("[Boot] 未找到 web/ 产物（开发模式请用 Vite dev server；或先执行 npm run build）");
}

/* ============ 启动 ============ */

app.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════════╗
║                                            ║
║     ◉ API 服务器已启动                      ║
║                                            ║
║     地址: http://localhost:${PORT}            ║
║     数据: 按用户分区 data/users/<uid>/       ║
║                                            ║
╚════════════════════════════════════════════╝
  `);
});
