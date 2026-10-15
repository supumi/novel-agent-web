/**
 * 小说工程后端
 *
 * 定位：把 novel-forge 的「真本事」接进 Web 应用 ——
 *   建书（设定+大纲） → 续写本章（记忆卡注入） → 回收（状态写回） → 质检（一致性 + AI 痕迹）
 *
 * 生成用的模型走用户自己在配置向导里填的接口（OpenAI 兼容 / 本机 CodeBuddy 登录），
 * 凭据只在请求头里走一趟，不落盘。
 *
 * 数据隔离：所有工程读写都落在 currentUser().dir 下，一个用户一个 novel.json。
 */

import express from 'express';
import fs from 'fs';
import path from 'path';

import { currentUser } from './users.js';
import { completeText, mapLimit } from './llm.js';
import { detect, rewriteBrief, ANTI_AI_GUIDE, needsDeAI } from './aidetect.js';

import {
  HOOK_STATE,
  REL_LABELS,
  MAX_OPEN_HOOKS,
  hookPressure,
  selectHooks,
  buildMemoryCard,
  makeSummary,
  applyStateUpdate,
  initMemory,
  memoryHealth,
  validate,
  validatePrompt,
  lint,
  lintScore,
  LINT_RULES,
  styleGuide,
  SELF_CHECK,
  newProject,
  projectStats,
  pendingConflicts,
} from './novel-engine.js';

/* ============ 1. 工程存储（按用户分区） ============ */

interface NovelStore {
  activeId: string | null;
  projects: any[];
}

/** 工程文件落在「当前用户」自己的目录里：data/users/<uid>/novel.json */
function storeFile(): string {
  return path.join(currentUser().dir, 'novel.json');
}

function loadStore(): NovelStore {
  const file = storeFile();
  try {
    if (fs.existsSync(file)) {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      return { activeId: raw.activeId ?? null, projects: raw.projects ?? [] };
    }
  } catch (e: any) {
    console.error('[Novel] 读取工程失败，将重建:', e?.message);
  }
  return { activeId: null, projects: [] };
}

function saveStore(store: NovelStore) {
  const dir = currentUser().dir;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'novel.json'), JSON.stringify(store, null, 2), 'utf8');
}

function activeProject(store: NovelStore): any | null {
  return store.projects.find((p) => p.id === store.activeId) ?? null;
}

/* ============ 2. 模型调用（走用户自己填的接口） ============ */

interface CompleteOpts {
  label?: string;
  maxTokens?: number;
  temperature?: number;
  /** 期望最少字数：不足会自动续写（长正文防截断） */
  minChars?: number;
  /** 被截断时最多续写几轮 */
  continueOnTruncate?: number;
}

async function complete(system: string, user: string, opts: CompleteOpts = {}): Promise<string> {
  const { llm } = currentUser();
  if (llm.protocol === 'openai' && (!llm.apiKey || !llm.baseUrl || !llm.model)) {
    throw new Error('还没有配置可用的模型，请先在设置里填写你自己的 LLM API');
  }
  return completeText(llm, system, user, {
    label: opts.label || 'complete',
    maxTokens: opts.maxTokens,
    temperature: opts.temperature,
    minChars: opts.minChars,
    continueOnTruncate: opts.continueOnTruncate,
  });
}

/**
 * 建书并行展开的并发数。
 *
 * OpenAI 兼容接口并发基本免费（就是一个 HTTP 请求），4 路能把 8 分钟的串行建书压到 1 分多钟。
 *
 * 但「本机 CodeBuddy 登录」走的是 SDK —— 每次调用都要拉起一个 CodeBuddy 命令行边车，
 * 而边车抢的是**同一个固定端口 127.0.0.1:56713**。4 个一起上必然互相踩：
 * 实测 7 个子任务里 6 个报 EADDRINUSE，只剩一个抢到端口的能跑通。
 * 所以这种协议只能串行 —— 慢，但拿得到结果。
 */
function buildConcurrency(): number {
  return currentUser().llm.protocol === 'codebuddy' ? 1 : 4;
}

/** 解析 JSON，失败时抛错（并带上原始片段，方便定位） */
function parseJSON(raw: string): any {
  return extractJSON(raw);
}
/** 容错版：解析失败返回 fallback，不打断整条流水线 */
function parseJSONSafe(raw: string, fallback: any, label: string): any {
  try {
    return extractJSON(raw);
  } catch (e: any) {
    console.warn(`[Novel] ${label} JSON 解析失败，用兜底值：${e?.message?.slice(0, 120)}`);
    return fallback;
  }
}

/** 模型有时会裹 ```json 围栏，这里剥掉并定位第一个完整 JSON */
function extractJSON(text: string): any {
  if (!text) throw new Error('模型没有返回内容');
  let s = text.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();

  try {
    return JSON.parse(s);
  } catch {
    /* 继续尝试截取 */
  }
  const objStart = s.search(/[[{]/);
  if (objStart >= 0) {
    const open = s[objStart];
    const close = open === '{' ? '}' : ']';
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = objStart; i < s.length; i++) {
      const ch = s[i];
      if (esc) { esc = false; continue; }
      if (ch === '\\') { esc = true; continue; }
      if (ch === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (ch === open) depth++;
      else if (ch === close) {
        depth--;
        if (depth === 0) {
          try {
            return JSON.parse(s.slice(objStart, i + 1));
          } catch {
            break;
          }
        }
      }
    }
  }
  throw new Error(`无法解析模型返回的 JSON：${text.slice(0, 200)}`);
}

/* ============ 3. 提示词（建书拆成「1 次骨架 + N 次并行展开」） ============ */

/**
 * 建书为什么要拆：
 *   原来是一次 bible 调用（6000+ 字）+ 一次 outline 调用（4500+ 字），全程串行。
 *   模型吞吐约 20 字/秒，加起来 8 分钟起步 —— 用户等不起。
 *
 * 拆法：
 *   关卡 1（串行，1 次）：只定骨架 —— 标题 / 一句话故事 / 人物名单 / 三幕主线 /
 *                        伏笔与支线的**标题**。产出压到 400 字以内，十几秒就回来。
 *   关卡 2（并行，7 次）：世界规则 / 人物档案 / 势力与关系 / 伏笔支线细化 /
 *                        大纲三批（1–4、5–8、9–12）。
 *                        它们彼此不依赖，只需要关卡 1 的骨架，所以可以同时发。
 *
 * 理论耗时：15s + max(各子任务) ≈ 1.5 分钟，而不是 8 分钟。
 * 关键是关卡 1 必须把「伏笔标题」这类**跨任务共享的标识符**先定下来，
 * 否则大纲批次不知道有哪些伏笔可埋，就会各写各的。
 */

const PLANNER_SYSTEM = `你是一位资深小说策划，擅长把一个创意种子扩展成可执行的长篇结构。
输出必须是严格的 JSON，不要任何解释文字，不要 markdown 代码块标记，不要在 JSON 前后加任何字符。
你写的每一条都必须能直接约束剧情，不要形容词堆砌，不要世界观介绍。`;

/** 关卡 1：骨架（唯一串行的一次，必须短） */
function buildSkeletonPrompt(seed: string, chapterCount: number) {
  return {
    system: PLANNER_SYSTEM,
    user: `创意种子：${seed || '（未提供，请自由发挥一个适合长篇的故事）'}

先定下这部 ${chapterCount} 章小说的骨架。输出 JSON：
{
  "title": "作品名（≤8 字，不要书名号）",
  "premise": "一句话故事：主角想要什么 + 被什么挡住（≤40 字）",
  "cast": [{"name":"姓名","role":"在故事里的职能（≤10 字）"}],
  "spine": ["第一幕：…", "第二幕：…", "第三幕：…"],
  "foreshadows": ["伏笔标题1", "伏笔标题2", "伏笔标题3"],
  "threads": ["支线标题1", "支线标题2"]
}

要求：
- cast 给 4 到 5 个人。名字要具体、像真人名，不要「A」「男主」「黑衣人」这种占位
- 这些人的职能必须互相冲突，不要凑数
- spine 三幕各一句话（≤25 字），说清这一段主角的处境怎么变
- foreshadows 给 3 到 5 个标题（每个 ≤10 字），必须能在后文回收
- threads 给 2 到 3 个标题（每个 ≤10 字）

**整段 JSON 控制在 400 字以内。写短。**`,
  };
}

type Skeleton = {
  title?: string;
  premise?: string;
  cast?: Array<{ name: string; role?: string }>;
  spine?: string[];
  foreshadows?: string[];
  threads?: string[];
};

function skCastList(sk: Skeleton) {
  return (sk.cast || [])
    .map((c) => `${c.name}${c.role ? `（${c.role}）` : ''}`)
    .join('；');
}
const skCastNames = (sk: Skeleton) => (sk.cast || []).map((c) => c.name).join('、');
const skForeshadowTitles = (sk: Skeleton) => (sk.foreshadows || []).join('、') || '（无，可自行拟定）';
const skThreadTitles = (sk: Skeleton) => (sk.threads || []).join('、') || '（无）';

function skContext(sk: Skeleton) {
  return `作品：${sk.title || '未命名'}
一句话故事：${sk.premise || ''}
主要人物：${skCastList(sk)}
三幕主线：
${(sk.spine || []).map((s, i) => `  ${i + 1}. ${s}`).join('\n')}`;
}

/** 关卡 2-1：世界规则 */
function buildWorldPrompt(sk: Skeleton) {
  return {
    system: PLANNER_SYSTEM,
    user: `${skContext(sk)}

请定下 4 到 6 条世界规则。输出 JSON：
{"world":[{"name":"设定名（≤8 字）","rule":"这条规则如何限制角色的选择（≤40 字）"}]}

要求：
- 每条规则都必须**能卡住主角**：要么限制他能做什么，要么让他的每个选择都有代价
- 不要写世界观介绍、不要写历史背景、不要写地理
- 不要出现「这个世界的规则是…」这种说明句，直接写规则本身
- 至少有一条规则和主角的「想要」直接冲突`,
  };
}

/** 关卡 2-2：人物档案 */
function buildCastPrompt(sk: Skeleton) {
  return {
    system: PLANNER_SYSTEM,
    user: `${skContext(sk)}

人物名单（必须严格用这些名字，不要增减、不要改名）：
${skCastList(sk)}

请给每个人写档案。输出 JSON：
{"characters":[{"name":"名单里的名字","want":"他明确想要的东西（≤25 字）","wound":"他不承认的创伤（≤25 字）","voice":"说话方式特征（≤25 字）","state":"故事开始时的处境（≤25 字）"}]}

要求：
- want 必须是具体可达成的事（找到一个人、拿到一样东西、保住一份工作），不要「想要自由」这种空话
- wound 必须是一件**具体发生过的事**，不是性格描述（写「十二岁那年他把弟弟锁在门外」而不是「童年缺爱」）
- wound 决定了他为什么非要不择手段地拿到 want，两者要咬合
- voice 写他的语言习惯（爱用短句 / 从不正面回答 / 总在纠正别人用词），不要写「说话温和」
- 几个人的 want 不能重复`,
  };
}

/** 关卡 2-3：势力与初始关系 */
function buildRelationsPrompt(sk: Skeleton) {
  return {
    system: PLANNER_SYSTEM,
    user: `${skContext(sk)}

请给出势力与初始关系表。输出 JSON：
{"factions":[{"name":"势力名（≤8 字）","goal":"这个势力要什么（≤25 字）","members":["人物名"]}],
 "relations":[{"from":"人物A","to":"人物B","kind":"ally|enemy|master|debt|unknows|broken","note":"这两人是什么关系（≤25 字）"}]}

要求：
- 2 到 3 个势力。主角必须至少属于其中一个，且至少有一个势力和他对立
- relations 是**有向**的：A 对 B 和 B 对 A 分别写，两边可以不同
- kind 含义：ally 同盟 / enemy 敌对 / master A 是 B 的上级 / debt A 欠 B 人情 /
  unknows 关系未明 / broken 已决裂。**上下级一律用 master，不要写成 unknows。**
- 主角对每一个人都要有一条；其余人物之间有明显关系的也要写
- 最多 12 条
- **至少写 2 条不对称的关系**（A 对 B 是 ally，B 对 A 却是 unknows 或 enemy）——
  这是后面冲突的来源`,
  };
}

/** 关卡 2-4：伏笔与支线细化 */
function buildForeshadowPrompt(sk: Skeleton, chapterCount: number) {
  return {
    system: PLANNER_SYSTEM,
    user: `${skContext(sk)}

伏笔与支线标题（必须严格用这些标题，不要增减、不要改名）：
伏笔：${skForeshadowTitles(sk)}
支线：${skThreadTitles(sk)}

请给每一条写清楚「将来怎么收」。输出 JSON：
{"foreshadows":[{"title":"原标题","note":"将来怎么回收（≤30 字）","payAt":7}],
 "threads":[{"title":"原标题","note":"为什么必须解决（≤30 字）"}]}

要求：
- note 要写**具体的回收方式**：谁在什么场合、揭穿什么。不要写「后面会揭晓」
- payAt 是计划回收的章号（数字），必须 ≥ 埋设章 +3，且不超过 ${chapterCount}
- 支线必须和主线有交集，不要各写各的`,
  };
}

/** 关卡 2-5/6/7：大纲分批（三批并行） */
function buildOutlineBatchPrompt(sk: Skeleton, from: number, to: number, mandate: string) {
  const count = to - from + 1;
  return {
    system: PLANNER_SYSTEM,
    user: `${skContext(sk)}

可用伏笔：${skForeshadowTitles(sk)}
可用支线：${skThreadTitles(sk)}

请**只**规划第 ${from} 到第 ${to} 章。输出 JSON 数组（正好 ${count} 个元素，num 从 ${from} 到 ${to} 连续）：
[{"num":${from},"title":"章节名（≤8 字）","goal":"本章要完成的叙事任务（≤30 字）",
  "beats":["场景（≤20 字）","场景（≤20 字）"],
  "plantForeshadow":"本章埋的伏笔标题（必须是上面「可用伏笔」里的，没有就写 null）",
  "payForeshadow":"本章回收的伏笔标题（必须是上面「可用伏笔」里的，没有就写 null）"}]

这一段（第 ${from}–${to} 章）在整体结构里的任务是：
${mandate}

节奏要求：
- 每一章都必须发生至少一次**不可逆**的状态改变，否则就是水字数
- 每章 2 到 3 个场景，beats 要写具体的场景（谁在哪做什么），不要写「冲突升级」这种抽象词
- 同一章不要同时埋和收同一条伏笔
- 伏笔的埋和收之间至少隔 3 章

篇幅严格：goal ≤30 字，beats 每条 ≤20 字。写短、写具体，不要形容词。`,
  };
}

/** 三幕的叙事任务（按章数比例切分，12 章时即 1–4 / 5–8 / 9–12） */
function actMandate(from: number, to: number, total: number): string {
  const ratio = from / total;
  if (ratio < 0.34) {
    return `建立日常 → 打破日常。第 ${from} 章必须让读者看清主角的日常、以及他在意什么，**不能直接进危机**；
第 ${from + 1} 章引入干扰；主角第一次做出选择；第 ${to} 章结尾必须发生一件让他无法回头的事。
这一段的重点是**让读者在乎主角**，不是推进事件。`;
  }
  if (ratio < 0.67) {
    return `中点反转。主角以为自己搞懂了局面，结果发现判断错了，或者对手比他想的更早动手；
第 ${Math.round((from + to) / 2)} 章左右要出现一次重大挫折；第 ${to} 章结尾主角必须从被动转为主动，
明确说出他要做什么。这一段允许回收 1 条伏笔。`;
  }
  return `高潮与收束。第 ${from}–${from + 1} 章集中回收主要伏笔（每条伏笔都要在这里兑现）；
第 ${to - 1} 章是最后的对抗；第 ${to} 章收尾但**不要大团圆** ——
留一个具体的、不解释的余味（一件没带走的东西、一句没说完的话）。`;
}

/** 按比例把 chapterCount 切成 3 段 */
function splitActs(chapterCount: number): Array<{ from: number; to: number }> {
  const n = Math.max(3, chapterCount);
  const a = Math.max(1, Math.round(n / 3));
  const b = Math.max(a + 1, Math.round((n * 2) / 3));
  return [
    { from: 1, to: a },
    { from: a + 1, to: b },
    { from: b + 1, to: n },
  ];
}

/**
 * 每章目标字数：按总章数分配。
 * 章数少就写长一点（读者会要求「一章顶别人三章」），章数多就压一压，
 * 否则一本 30 章的书要写十万字，模型和用户都撑不住。
 */
function draftWords(chapterCount: number): number {
  const n = chapterCount || 12;
  if (n <= 8) return 3200;
  if (n <= 16) return 2800;
  if (n <= 30) return 2400;
  return 2200;
}

/** 草稿关卡：记忆卡注入 —— 「自动串起来」的核心 */
function buildDraftPrompt(project: any, chapterNum: number) {
  const outlineItem = project.outline.find((o: any) => o.num === chapterNum);
  // 本章目标字数：优先用大纲里定好的，其次按总章数推
  const targetWords = outlineItem?.targetWords || draftWords(project.outline.length);
  const mem = project.memory;
  const card = mem ? buildMemoryCard(mem, chapterNum) : null;

  const canon = card?.canon?.length
    ? card.canon.join('\n')
    : project.bible.characters
        .map((c: any) => `${c.name}｜身份:${c.role}｜想要:${c.want}｜创伤:${c.wound}｜口吻:${c.voice}`)
        .join('\n');

  const state = card?.state?.length ? '\n【人物当前位置】\n' + card.state.join('\n') + '\n' : '';
  const hooks = card?.hooks?.length ? '\n【本章要处理的钩子】\n' + card.hooks.join('\n') + '\n' : '';
  const rels = card?.relations?.length ? '\n【人物关系】\n' + card.relations.join('\n') + '\n' : '';
  const facs = card?.factions?.length ? '\n【阵营】\n' + card.factions.join('\n') + '\n' : '';
  const guard = card?.guard ? card.guard + '\n' : '';

  const prior = card?.lastChapter
    ? `【上一章结尾（直接接着这里写，不要重新开场）】\n${card.lastChapter.slice(-900)}\n`
    : (() => {
        const prev = project.chapters
          .filter((c: any) => c.num < chapterNum && c.content)
          .sort((a: any, b: any) => b.num - a.num)[0];
        return prev ? `【上一章结尾】\n${prev.content.slice(-600)}\n` : '';
      })();

  const brief = card?.recentSummary?.length
    ? `\n【前情提要】\n${card.recentSummary.join('\n')}\n`
    : '';

  return {
    system: `你是一位写网文的写手。你的目标是写出读者读不出"这是AI写的"的正文。

最重要的一条：写具体，不写感受。
- 具体＝物件、动作、生理反应、数字
- 写"他很难过"之前先问：他手里正在做什么？手在做什么就是答案。
- 不要命名情绪，不要抽象比喻，不要下判断，不要用连接词宣布转折。

${ANTI_AI_GUIDE}

${styleGuide(true)}

${SELF_CHECK}`,
    user: `【作品】${project.title}
【故事】${project.bible.premise}

【设定（不可改）】
${canon}
${state}${facs}${rels}${guard}${hooks}
${brief}${prior}
【本章任务】
第 ${chapterNum} 章：${outlineItem?.title || '继续'}
${outlineItem?.goal ? '目标：' + outlineItem.goal : ''}
${(outlineItem?.beats || []).length ? '场景：' + outlineItem.beats.join(' → ') : ''}

${card?.due?.length ? `本章必须回收「${card.due[0].title}」，不要忘。` : ''}

现在写正文。目标 ${targetWords} 字，**不得少于 ${Math.round(targetWords * 0.85)} 字**。

要求：
- 写够字数。**不要提前收尾**，不要用一句总结草草结束。写到最后一段都还在推进事件。
- 如果写到一半发现故事已经讲完了，说明场景写得太粗 —— 回去把某个场景放慢，
  写清楚人物手边的动作、对话里的停顿，而不是再加一个收尾段落。
- 章节最后一段必须落在一个**具体的东西**上：一个动作、一件物件、一句没头没尾的对白。
  不要写"而这，才只是开始"这类升华。
- 段落长短要有落差：允许出现只有一句话、甚至两个字的段落。
- 句子长短也要有落差：同一段里要有 2–6 字的短句，也要有 30 字以上的长句。

只写正文本身。不要标题、不要解释、不要 markdown、不要"第X章"。

${card?.lastChapter ? '直接从上一章的动作继续，不要重新写一遍开场白。\n' : ''}
写之前先想：这个场景里，这个人手边能碰到什么？只写那些。
写完按清单自查一遍再输出。`,
  };
}

/** 回收关卡：从正文里抽出状态变更 */
function buildHarvestPrompt(project: any, chapterNum: number) {
  const chapter = project.chapters.find((c: any) => c.num === chapterNum);
  const charSheet = project.bible.characters.map((c: any) => `${c.name}｜当前状态:${c.state || '未交代'}`).join('\n');
  const fsSheet = project.bible.foreshadows
    .map((f: any) => `${f.title}｜状态:${f.status || 'planted'}｜备注:${f.note || ''}`)
    .join('\n');
  const openHooks = (project.memory?.hooks || [])
    .filter((h: any) => h.status === HOOK_STATE.open)
    .map((h: any) => `${h.title}（埋于第${h.plantedIn}章）`)
    .join('\n');

  // 当前关系表：不给这个，模型没法判断「关系变没变」，就会一律不报 —— 关系图永远是空的
  const activeRels = (project.memory?.relations || []).filter((r: any) => r.until == null);
  const relSheet = activeRels
    .map((r: any) => `${r.from} → ${r.to}：${REL_LABELS[r.kind] || r.kind}${r.label ? '（' + r.label + '）' : ''}`)
    .join('\n');

  return {
    system: `你是一位小说连续性审校。你的唯一任务是：从刚写完的正文里，
把「故事状态发生了什么变化」逐条抽出来，输出严格的 JSON 数组。
不要评价好坏，不要改写正文，只做事实抽取。
如果某一类变化确实没有发生，就不要输出那一类。输出必须是 JSON 数组，不要任何其他文字。`,
    user: `【当前设定】
人物：
${charSheet}

伏笔表：
${fsSheet}

当前开着的钩子：
${openHooks || '（无）'}

当前人物关系（有向，A → B 读作「A 对 B」）：
${relSheet || '（暂无）'}

【本章正文】第 ${chapterNum} 章
${chapter?.content || ''}

【请抽取】
[
 {"kind":"foreshadow_plant","target":"伏笔标题","detail":"这个钩子是什么","payPlan":"将来怎么收"},
 {"kind":"foreshadow_pay","target":"已有钩子标题","detail":"怎么收的"},
 {"kind":"character_update","target":"人物名","field":"state","before":"原状态","after":"新状态"},
 {"kind":"relation_change","from":"人物A","to":"人物B","relationKind":"ally|enemy|master|debt|unknows|broken","detail":"关系怎么变的"},
 {"kind":"faction_change","target":"人物名","detail":"转到哪个势力了"},
 {"kind":"death","target":"人物名","detail":"怎么死的、什么时候"},
 {"kind":"attribute","target":"人物名","field":"属性名","detail":"新值"},
 {"kind":"clock","detail":"故事内时间现在是什么"},
 {"kind":"world_add","target":"设定名","detail":"这条新规则是什么"},
 {"kind":"thread_open","target":"支线标题","detail":"出现了什么未解决问题"},
 {"kind":"conflict","target":"冲突点","detail":"正文与哪条既有设定矛盾","severity":"high|mid"}
]

判断标准：
- 正文里明确写了、或者强烈暗示的，才算变化。推断要保守。
- 人物状态变化只记「不可逆的」，心情起伏不算。
- 关系是双向不对称的：A 恨 B 不代表 B 也恨 A。两边都要分别报。
- **relation_change 是重点产出，别省**：只要本章里两个人物**正面照面**并且发生了下面任一件事，
  就要报一条 relation_change：
    · 一方提出请求 / 试探 / 威胁，另一方接受、拒绝或回避
    · 立场、信任、亲疏发生了移动（哪怕只是开始提防）
    · 有一方撒了谎、隐瞒了信息，或替对方做了决定
  对每一对「本章有对手戏」的人物，**至少报一条**；两人的关系若同时变化，A→B 和 B→A 分开报。
  若对照上面的「当前人物关系」表，关系实质没变，才不报。
- 人物死了必须报 death，这是最不能漏的。
- 有人死了以后又出场，或者死人还有活跃同盟，都是硬伤——发现就报 conflict。
- 如果正文和既有设定矛盾，必须输出 conflict，不要自行圆场。

两个数量上限，务必遵守：
1. foreshadow_plant（埋新钩子）最多 1 条。
2. 总共最多 8 条（其中 relation_change 最多 3 条）。

**关于 foreshadow_pay，这是最不能漏的一类，请单独花力气做。**
把上面「当前开着的钩子」列出的每一条，逐条拿回正文里核对：
  · 如果本章正文里这条线索被**挑明、兑现、或被角色当面点破**了 →
    报一条 foreshadow_pay，target **原样照抄钩子标题**，detail 写清楚「是怎么收的、谁在哪揭的」。
  · 如果本章只是又提了一次、并没有真正兑现 → **不要报**，钩子还得继续开着。
宁可多报一条真的回收，也不要漏报 —— 漏报会让作者以为坑没填，回头重写整章。
注意：本章新埋的钩子，不要在同一章里又报回收。`,
  };
}

/* ============ 4. 质检 ============ */

const LINT_LEVEL_LABEL: Record<string, string> = {
  obvious: 'AI 味明显',
  suspect: '疑似 AI',
  mild: '轻微痕迹',
  clean: '自然',
};

/**
 * 跑一遍 AI 痕迹检测，返回给前端可直接渲染的结构。
 *
 * 注意：这里用的是 aidetect.detect()，不是上游的 lint()。
 * 上游 lint 是纯词表规则（「仿佛」出现几次就扣几分），
 * 而朱雀这类检测器看的是**统计特征** —— 句长方差、短句占比、「的」密度。
 * 词表干净但节奏均匀的文本，能骗过 lint，骗不过朱雀。
 * detect() 把统计维度按 6:4 的权重压过词表维度，所以分数更接近真实检测结果。
 */
function lintReport(text: string) {
  const r = detect(text);
  return {
    score: r.score,
    level: r.grade,
    label: r.label || LINT_LEVEL_LABEL[r.grade] || '未知',
    /** 统计节奏维度（过检测的主力） */
    rhythm: r.rhythm,
    /** 用词维度 */
    lexical: r.lexical,
    hits: r.hits.map((h) => ({
      rule: h.ruleId || '',
      label: h.label || h.ruleId || '',
      severity: h.severity || '',
      text: h.excerpt || '',
      fix: h.suggest || h.desc || '',
      line: h.line ?? null,
      col: h.col ?? null,
      /** 段落序号，前端可以据此定位 */
      para: h.para,
      source: h.source,
    })),
    metrics: r.metrics,
    stats: r.metrics,
    ruleCount: r.ruleCount,
  };
}

/* ============ 4.5 长任务通道：SSE 心跳 + 降 AI 味 + 钩子兜底 ============ */

/** 长任务进度回调。有 SSE 通道就往浏览器推，没有就静默。 */
type Emit = (message: string, step?: string, extra?: Record<string, any>) => void;

interface SseChannel {
  emit: Emit;
  done: (payload: Record<string, any>) => void;
  fail: (message: string) => void;
  close: () => void;
}

/**
 * 开一条 SSE 通道。
 *
 * 为什么建书 / 存稿要走 SSE 而不是普通 POST：
 *   这两件事要跑一两分钟。普通 POST 在这期间是完全静默的，连接上没有任何字节，
 *   反向代理（nginx 的 proxy_read_timeout、各种 PaaS 网关）会判定连接已死直接掐断。
 *   用户看到「请求失败」，服务端其实还在跑 —— 白等一场，还可能写进半截数据。
 *   SSE 每 8 秒发一个注释行，连接始终是活的；顺带把进度实时推给前端。
 */
function openSse(res: express.Response): SseChannel {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  let closed = false;
  const timer = setInterval(() => {
    if (closed) return;
    try {
      res.write(': keep-alive\n\n');
    } catch {
      /* 连接已断，忽略 */
    }
  }, 8000);

  const write = (obj: any) => {
    if (closed) return;
    try {
      res.write(`data: ${JSON.stringify(obj)}\n\n`);
    } catch {
      /* ignore */
    }
  };

  return {
    emit: (message, step, extra) => write({ type: 'progress', message, step: step || '', ...(extra || {}) }),
    done: (payload) => write({ type: 'done', ok: true, ...payload }),
    fail: (message) => write({ type: 'error', error: message }),
    close: () => {
      closed = true;
      clearInterval(timer);
      try {
        res.end();
      } catch {
        /* ignore */
      }
    },
  };
}

/** 客户端是不是要 SSE（前端带 Accept: text/event-stream）；否则退回一次性 JSON */
function wantsSse(req: express.Request): boolean {
  return String(req.headers.accept || '').includes('text/event-stream');
}

/**
 * 按「保留原分隔符」的方式把改写后的段落拼回去。
 * detect / rewriteBrief 里的段落编号来自 text.split(/\n+/)，
 * 与 split(/(\n+)/) 里的偶数下标一一对应，所以能直接按序号回填。
 */
function applyParaRewrites(text: string, rewrites: Map<number, string>): string {
  const parts = text.split(/(\n+)/);
  let pi = 0;
  for (let i = 0; i < parts.length; i += 2) {
    const r = rewrites.get(pi);
    if (r != null) parts[i] = r;
    pi++;
  }
  return parts.join('');
}

interface DeAIResult {
  text: string;
  before: number;
  after: number;
  applied: boolean;
  rounds: number;
  trace: Array<{ round: number; score: number }>;
}

/**
 * 自动降 AI 味：定点重写命中的段落，直到分数降下来或轮次用完。
 *
 * 为什么是定点重写而不是整篇重写：
 *   1. 整篇重写会把已经写对的地方也改坏 —— 模型每写一遍都是另一段文本，
 *      改完的稿子可能比原来更差；
 *   2. token 成本高，而且长文本整篇重写自己就容易截断（正好踩中「写长文会崩」）；
 *   3. 朱雀看的是统计特征，只要把那十几段节奏不对的改掉，全篇指标就下来了。
 * 只改有问题的段落，改动最小、收益最大、风险最低。
 */
async function runDeAIPass(
  text: string,
  opts: { threshold?: number; maxRounds?: number; emit?: Emit } = {},
): Promise<DeAIResult> {
  const threshold = opts.threshold ?? 32;
  const maxRounds = opts.maxRounds ?? 2;
  const emit = opts.emit;

  let current = text;
  let report = detect(current);
  const before = report.score;
  const trace: Array<{ round: number; score: number }> = [{ round: 0, score: before }];
  let rounds = 0;

  // 比好坏：总分优先（朱雀看统计），总分相同再比用词分。
  // 只接受真的变好的结果，否则回退 —— 不能为了降分把稿子改坏。
  const betterThan = (next: any, cur: any) =>
    next.score !== cur.score ? next.score < cur.score : next.lexical < cur.lexical;

  while (needsDeAI(report, threshold) && rounds < maxRounds) {
    const brief = rewriteBrief(report, current);
    const targets = [...brief.matchAll(/【第 (\d+) 段】/g)]
      .map((m) => Number(m[1]) - 1)
      .filter((n) => n >= 0);
    if (!targets.length) break;

    emit?.(`第 ${rounds + 1} 轮降味：定点重写 ${targets.length} 段（当前 ${report.score} 分）`, 'deai');

    const system = `你是中文小说编辑，只做一件事：把给定的段落改写得不像机器写的。
你必须保持剧情、人物、事实、对话内容完全不变 —— 只改句子的长短节奏和用词。
输出必须是严格的 JSON 数组，不要任何解释文字，不要 markdown 代码块。`;

    const user = `${brief}

请改写上面列出的每一段。输出 JSON 数组：
[{"i": 段号, "text": "改写后的段落"}]

要求：
- i 用上面【第 N 段】里的 N，原样照抄，不要重新编号，不要漏段、不要多写
- **剧情、人物、事实、对话一字不能改**。原来发生什么，改完还是发生什么
- 制造句子长短落差：一段里要有 2–6 字的短句，也要有 30 字以上的长句
- 删掉定语里的「的」（「他的手里」→「他手里」）
- 删掉这些词：仿佛、似乎、宛如、一丝、一抹、悄然、不禁、然而、因此、与此同时
- 删掉「不是…而是…」「不仅…而且…」这类对举句式
- 段落结尾不要升华，落在一个具体的动作或物件上
- 改写后每段字数不得少于原文的 60%（不能靠删内容来降分）`;

    let parsed: any;
    try {
      const raw = await complete(system, user, { label: `deai r${rounds + 1}` });
      parsed = parseJSON(raw);
    } catch (e: any) {
      console.warn(`[Novel] 降味重写失败：${e?.message?.slice(0, 120)}`);
      break;
    }

    const list = Array.isArray(parsed) ? parsed : [];
    const parts = current.split(/(\n+)/);
    const paraCount = Math.ceil(parts.length / 2);
    const rewrites = new Map<number, string>();

    for (const it of list) {
      const idx = Number(it?.i) - 1;
      const next = typeof it?.text === 'string' ? it.text.trim() : '';
      if (!Number.isFinite(idx) || idx < 0 || idx >= paraCount) continue;
      if (!next) continue;
      const orig = (parts[idx * 2] || '').replace(/\s/g, '');
      const now = next.replace(/\s/g, '');
      // 明显缩水说明模型在偷工减料（丢了对白或动作），宁可保留原文
      if (orig.length > 20 && now.length < orig.length * 0.6) continue;
      rewrites.set(idx, next);
    }
    if (!rewrites.size) break;

    const candidate = applyParaRewrites(current, rewrites);
    const nextReport = detect(candidate);
    rounds++;
    trace.push({ round: rounds, score: nextReport.score });

    // 只接受真的变好的结果，否则回退 —— 不能为了降分把稿子改坏
    if (betterThan(nextReport, report)) {
      current = candidate;
      report = nextReport;
    } else {
      console.warn(`[Novel] 降味第 ${rounds} 轮没有变好（${report.score} → ${nextReport.score}），回退`);
      break;
    }
  }

  return { text: current, before, after: report.score, applied: current !== text, rounds, trace };
}

/**
 * 钩子确定性兜底。
 *
 * harvest 是让模型自己报「我这一章收了哪些钩子」，而模型经常漏报 ——
 * 正文里明明已经把那条伏笔揭穿了，它就是不输出 foreshadow_pay，
 * 结果钩子永远开着、压力越堆越高，体检页一片「拖太久」。
 * 这里做一次机械核对：开着的钩子标题如果**逐字出现**在正文里，就判定为已回收。
 * 宁可多收一个，也不要让读者觉得作者把坑忘了。
 */
function autoCloseHooksByText(project: any, chapterNum: number, text: string): string[] {
  const mem = project.memory;
  if (!mem) return [];
  const notes: string[] = [];
  const flat = text.replace(/\s/g, '');

  for (const h of mem.hooks || []) {
    if (h.status !== HOOK_STATE.open) continue;
    const title = String(h.title || '').replace(/\s/g, '');
    // 标题太短（两字以内）容易误伤，跳过
    if (title.length < 3) continue;
    if (!flat.includes(title)) continue;
    // 埋设的当章不算回收
    if (h.plantedIn === chapterNum) continue;
    h.status = HOOK_STATE.closed;
    h.closedIn = chapterNum;
    h.closedBy = '正文已出现该线索，自动判定为回收';
    notes.push(`自动回收钩子「${h.title}」（正文里已经写到，模型漏报了）`);
  }

  // 伏笔表同步状态，导出设定档案时不会还写着「未回收」
  for (const f of project.bible?.foreshadows || []) {
    if (f.status === 'paid') continue;
    const title = String(f.title || '').replace(/\s/g, '');
    if (title.length < 3) continue;
    if (flat.includes(title) && (f.plantedIn || 1) !== chapterNum) {
      f.status = 'paid';
      f.paidIn = chapterNum;
    }
  }
  return notes;
}

/* ============ 5. 路由 ============ */

const router = express.Router();

/** 工程摘要：状态条要的数字全在这里 */
function projectSummary(project: any) {
  const st = projectStats(project);
  const mem = project.memory;
  const chNum = project.currentChapter;
  const health = mem ? memoryHealth(mem, chNum) : null;
  const hooks = mem
    ? mem.hooks.map((h: any) => {
        const pressure = hookPressure(h, chNum);
        const PRESSURE_LABEL: Record<string, string> = {
          cold: '刚埋',
          warm: '正常',
          due: '该收',
          overdue: '拖太久',
          rotten: '该处理',
        };
        return {
          ...h,
          pressure,
          pressureLabel: pressure ? PRESSURE_LABEL[pressure.level] ?? null : null,
        };
      })
    : [];
  const sel = mem ? selectHooks(mem, chNum) : null;

  return {
    id: project.id,
    title: project.title,
    seed: project.seed,
    stage: project.stage,
    currentChapter: chNum,
    outlineTotal: project.outline.length,
    stats: st,
    health,
    hooks,
    selection: sel,
    maxOpenHooks: MAX_OPEN_HOOKS,
    relLabels: REL_LABELS,
  };
}

/** 当前工程全貌 */
router.get('/state', (_req, res) => {
  const store = loadStore();
  const project = activeProject(store);
  if (!project) return res.json({ hasProject: false, projects: store.projects.map((p) => ({ id: p.id, title: p.title, chapters: p.chapters.length })) });
  res.json({
    hasProject: true,
    summary: projectSummary(project),
    projects: store.projects.map((p) => ({ id: p.id, title: p.title, chapters: p.chapters.length, active: p.id === store.activeId })),
  });
});

/**
 * 建书：一句创意 → 设定 + 大纲 + 记忆层
 *
 * 流水线结构（这是「提速」的全部秘密）：
 *   关卡 1（串行 1 次）：只出骨架 —— 标题 / 一句话故事 / 人物名单 / 三幕主线 /
 *                       伏笔与支线的**标题**。压到 400 字以内，十几秒回来。
 *   关卡 2（并行 7 次）：世界规则、人物档案、势力与关系、伏笔支线细化、
 *                       大纲三批。它们只依赖关卡 1 的骨架，彼此不依赖，同时发。
 *   合并：在代码里拼，不再让模型做一次「汇总」调用 —— 省一次往返，而且结果确定。
 *
 * 实测：原来串行两次大调用约 8 分钟，现在约 1.5 分钟。
 */
router.post('/new', async (req, res) => {
  const { seed, title, chapterCount = 12 } = req.body || {};
  if (!seed || !String(seed).trim()) {
    return res.status(400).json({ error: '请先写一句创意种子' });
  }

  const sse = wantsSse(req) ? openSse(res) : null;
  const emit: Emit = (message, step, extra) => {
    console.log(`[Novel] 建书 · ${message}`);
    sse?.emit(message, step, extra);
  };
  const t0 = Date.now();

  try {
    const total = Math.max(3, Math.min(60, Number(chapterCount) || 12));
    const project = newProject(String(seed).trim());
    if (title) project.title = title;

    /* ——— 关卡 1：骨架（唯一串行的一次，必须短） ——— */
    emit('正在定故事骨架（人物名单 / 三幕主线 / 伏笔标题）…', 'skeleton');
    const skPrompt = buildSkeletonPrompt(project.seed, total);
    const skRaw = await complete(skPrompt.system, skPrompt.user, {
      label: 'skeleton',
      maxTokens: 1600,
      minChars: 100,
    });

    let sk: Skeleton;
    try {
      sk = parseJSON(skRaw);
    } catch {
      throw new Error('模型没能给出可用的故事骨架，请重试一次，或换一个更稳的模型');
    }
    if (!sk || typeof sk !== 'object') throw new Error('模型返回的骨架不是对象，请重试');
    const tSkeleton = Date.now() - t0;

    const bookTitle = sk.title || project.title;
    emit(`骨架已定：《${bookTitle}》。开始并行展开 7 个子任务…`, 'expand', { title: bookTitle });

    /* ——— 关卡 2：7 个子任务并行 ——— */
    const acts = splitActs(total);

    interface BuildTask {
      key: string;
      label: string;
      run: () => Promise<any>;
    }

    const tasks: BuildTask[] = [
      {
        key: 'world',
        label: '世界规则',
        run: async () => {
          const p = buildWorldPrompt(sk);
          const raw = await complete(p.system, p.user, { label: 'world', maxTokens: 1400, minChars: 60 });
          return parseJSONSafe(raw, { world: [] }, 'world').world || [];
        },
      },
      {
        key: 'cast',
        label: '人物档案',
        run: async () => {
          const p = buildCastPrompt(sk);
          const raw = await complete(p.system, p.user, { label: 'cast', maxTokens: 2400, minChars: 120 });
          return parseJSONSafe(raw, { characters: [] }, 'cast').characters || [];
        },
      },
      {
        key: 'relations',
        label: '势力与关系',
        run: async () => {
          const p = buildRelationsPrompt(sk);
          const raw = await complete(p.system, p.user, { label: 'relations', maxTokens: 2000, minChars: 80 });
          return parseJSONSafe(raw, { factions: [], relations: [] }, 'relations');
        },
      },
      {
        key: 'foreshadow',
        label: '伏笔与支线',
        run: async () => {
          const p = buildForeshadowPrompt(sk, total);
          const raw = await complete(p.system, p.user, { label: 'foreshadow', maxTokens: 1600, minChars: 60 });
          return parseJSONSafe(raw, { foreshadows: [], threads: [] }, 'foreshadow');
        },
      },
      ...acts.map((act, i) => ({
        key: `outline${i}`,
        label: `大纲 ${act.from}–${act.to} 章`,
        run: async () => {
          const p = buildOutlineBatchPrompt(sk, act.from, act.to, actMandate(act.from, act.to, total));
          const raw = await complete(p.system, p.user, { label: `outline ${act.from}-${act.to}`, maxTokens: 3200, minChars: 200 });
          const parsed = parseJSONSafe(raw, [], `outline ${act.from}-${act.to}`);
          return Array.isArray(parsed) ? parsed : [];
        },
      })),
    ];

    let finished = 0;
    const concurrency = buildConcurrency();
    if (concurrency === 1) {
      emit('本机 CodeBuddy 登录方式一次只能跑一个子任务（命令行边车抢同一个端口），会慢一些，请耐心等…', 'expand');
    }
    const results = await mapLimit(tasks, concurrency, async (t) => {
      try {
        const value = await t.run();
        finished++;
        emit(`已完成 ${finished}/${tasks.length}：${t.label}`, 'expand', {
          finished,
          total: tasks.length,
        });
        return { key: t.key, value, ok: true as const };
      } catch (e: any) {
        finished++;
        // 单个子任务失败不该毁掉整本书：降级、记一笔、继续
        console.warn(`[Novel] 建书子任务「${t.label}」失败：${e?.message}`);
        emit(`「${t.label}」没跑出来，已用兜底值继续（${String(e?.message || '').slice(0, 40)}）`, 'expand', {
          finished,
          total: tasks.length,
        });
        return { key: t.key, value: null, ok: false as const };
      }
    });

    const byKey: Record<string, any> = {};
    for (const r of results) byKey[r.key] = r.value;

    /* ——— 合并（在代码里拼，不再调模型） ——— */
    emit('正在合并设定与大纲…', 'merge');

    const world = (byKey.world || [])
      .filter((w: any) => w && w.name)
      .map((w: any, i: number) => ({ id: `w${i}`, name: w.name, rule: w.rule || '' }));

    const roleOf = new Map<string, string>((sk.cast || []).map((c) => [c.name, c.role || '']));
    let characters = (byKey.cast || [])
      .filter((c: any) => c && c.name)
      .map((c: any, i: number) => ({
        id: `c${i}`,
        name: c.name,
        role: c.role || roleOf.get(c.name) || '',
        want: c.want || '',
        wound: c.wound || '',
        voice: c.voice || '',
        state: c.state || '',
      }));
    // 人物档案整批挂了也不能让书没主角：用骨架里的名单兜底
    if (!characters.length) {
      characters = (sk.cast || []).map((c, i) => ({
        id: `c${i}`,
        name: c.name,
        role: c.role || '',
        want: '',
        wound: '',
        voice: '',
        state: '',
      }));
    }

    const factions = (byKey.relations?.factions || [])
      .filter((f: any) => f && f.name)
      .map((f: any, i: number) => ({ id: `fa${i}`, name: f.name, goal: f.goal || '', members: f.members || [] }));

    const relations = (byKey.relations?.relations || [])
      .filter((r: any) => r && r.from && r.to)
      .map((r: any, i: number) => ({ id: `r${i}`, from: r.from, to: r.to, kind: r.kind, note: r.note || '' }));

    let foreshadows = (byKey.foreshadow?.foreshadows || [])
      .filter((f: any) => f && f.title)
      .map((f: any, i: number) => ({
        id: `f${i}`,
        title: f.title,
        note: f.note || '',
        payAt: Number(f.payAt) || null,
        plantedIn: 1,
        status: 'planted',
      }));
    if (!foreshadows.length) {
      foreshadows = (sk.foreshadows || []).map((t, i) => ({
        id: `f${i}`,
        title: t,
        note: '',
        payAt: null,
        plantedIn: 1,
        status: 'planted',
      }));
    }

    const threads = (byKey.foreshadow?.threads || [])
      .filter((t: any) => t && t.title)
      .map((t: any, i: number) => ({ id: `t${i}`, title: t.title, note: t.note || '', status: 'open' }));

    // 三批大纲合流
    const outline: any[] = [];
    for (const key of Object.keys(byKey)) {
      if (!key.startsWith('outline')) continue;
      for (const o of byKey[key] || []) {
        if (!o || !Number.isFinite(Number(o.num))) continue;
        outline.push({ ...o, num: Number(o.num) });
      }
    }
    outline.sort((a, b) => a.num - b.num);

    // 去重（同一章被两批都写了的话，保留前一批）
    const seen = new Set<number>();
    const deduped = outline.filter((o) => (seen.has(o.num) ? false : (seen.add(o.num), true)));

    // 补齐缺口：某一批挂了的时候，至少留个占位，别让 /next 找不到大纲项
    const words = draftWords(total);
    for (let n = 1; n <= total; n++) {
      if (seen.has(n)) continue;
      const act = acts.find((a) => n >= a.from && n <= a.to);
      deduped.push({
        num: n,
        title: `第 ${n} 章`,
        goal: act ? actMandate(act.from, act.to, total).split('\n')[0].slice(0, 30) : '继续推进',
        beats: [],
        plantForeshadow: null,
        payForeshadow: null,
      });
    }
    deduped.sort((a, b) => a.num - b.num);
    const outlineFinal = deduped.slice(0, total).map((o) => ({ ...o, targetWords: words }));

    /* ——— 落到工程对象 ——— */
    project.title = bookTitle;
    project.bible.premise = sk.premise || '';
    project.bible.world = world;
    project.bible.characters = characters;
    project.bible.factions = factions;
    project.bible.foreshadows = foreshadows;
    project.bible.threads = threads;
    project.bible.relations = relations;
    project.bible.timeline = [];
    project.outline = outlineFinal;

    // 初始化记忆层（canon / state / hooks）
    project.memory = initMemory(project.bible);

    // 支线也播种进状态层。不播的话体检页的「支线」永远是 0，
    // 而 stats 里却有 2 条，两边对不上，用户会以为数据丢了。
    project.memory.state.threads = threads.map((t: any) => ({
      title: t.title,
      detail: t.note || '',
      openedIn: 1,
      status: 'open',
    }));

    // 把设定层就写明的人物关系直接播种进关系图。
    // initMemory 只会给空数组，但「甲是乙的上司」这种关系是设定层定死的，
    // 不该等模型写正文时去「发现」—— 否则关系图一开始永远是空的。
    project.memory.relations = relations.map((r: any) => ({
      from: r.from,
      to: r.to,
      kind: REL_LABELS[r.kind] ? r.kind : 'unknows',
      label: r.note || '初始设定',
      since: 1,
      until: null,
    }));

    project.stage = 'draft';
    project.currentChapter = 1;

    const failed = results.filter((r) => !r.ok).map((r) => r.key);
    const elapsed = Date.now() - t0;
    project.log.push({
      ts: new Date().toISOString(),
      stage: 'bible',
      action: '设定与大纲已生成',
      detail:
        `${characters.length} 个人物 · ${world.length} 条设定 · ${factions.length} 个势力 · ` +
        `${project.memory.relations.length} 条初始关系 · ${outlineFinal.length} 章大纲 · ` +
        `耗时 ${(elapsed / 1000).toFixed(1)}s（骨架 ${(tSkeleton / 1000).toFixed(1)}s）` +
        (failed.length ? ` · 降级项：${failed.join('、')}` : ''),
    });

    const store = loadStore();
    store.projects.push(project);
    store.activeId = project.id;
    saveStore(store);

    emit(`《${bookTitle}》建好了：${outlineFinal.length} 章大纲，用时 ${(elapsed / 1000).toFixed(1)} 秒`, 'done');

    const payload = {
      project: projectSummary(project),
      bible: project.bible,
      outline: project.outline,
      timings: { total: elapsed, skeleton: tSkeleton },
      degraded: failed,
    };

    if (sse) {
      sse.done(payload);
      sse.close();
    } else {
      res.json({ ok: true, ...payload });
    }
  } catch (e: any) {
    console.error('[Novel] 建书失败:', e);
    const msg = e?.message || '建书失败';
    if (sse) {
      sse.fail(msg);
      sse.close();
    } else {
      res.status(500).json({ error: msg });
    }
  }
});

/** 现想灵感：不想用预置池时，让模型给几条具体的创意种子 */
router.post('/inspire', async (req, res) => {
  const { tag, count = 5, avoid = [] } = req.body || {};
  try {
    const system = `你是小说策划，擅长把抽象题材落成具体的故事种子。
你给的从来不是题材词、不是梗概，而是一句能直接开写的中文句子。`;
    const user = `给我 ${count} 条小说创意种子${tag && tag !== '全部' ? `，题材：${tag}` : ''}。

每条要求：
- 一句话，20–45 字
- 必须有具体的职业 / 物件 / 场景，不要抽象概念
- 内含一个「主角想要什么 vs 被什么挡住」的矛盾
- 不要解释、不要评价、不要任何编号之外的文字

${avoid.length ? `不要和下面这些重复或雷同：\n${avoid.map((s: string) => '· ' + s).join('\n')}\n` : ''}
输出严格的 JSON 数组：["种子1","种子2"]`;

    const raw = await complete(system, user, { label: 'inspire' });
    const parsed = extractJSON(raw);
    const list = (Array.isArray(parsed) ? parsed : [])
      .filter((s: any) => typeof s === 'string' && s.trim())
      .slice(0, count);
    if (!list.length) throw new Error('模型没有返回可用的种子');
    res.json({
      ok: true,
      seeds: list.map((s: string, i: number) => ({
        id: `ai_${Date.now()}_${i}`,
        tag: tag && tag !== '全部' ? tag : 'AI 现想',
        seed: s.trim(),
      })),
    });
  } catch (e: any) {
    console.error('[Novel] 生成灵感失败:', e);
    res.status(500).json({ error: e?.message || '生成灵感失败' });
  }
});

/** 从设定 + 已写章节重扫人物关系（老工程补数据 / 图太稀时用） */
router.post('/relations/rebuild', async (req, res) => {
  const store = loadStore();
  const project = activeProject(store);
  if (!project?.memory) return res.status(404).json({ error: '还没有小说工程' });

  const chapters = project.chapters
    .filter((c: any) => c.content)
    .sort((a: any, b: any) => a.num - b.num)
    .map((c: any) => `【第 ${c.num} 章 ${c.title}】\n${c.content.slice(0, 3000)}`)
    .join('\n\n');

  if (!chapters) return res.status(400).json({ error: '还没写正文，没法重扫' });

  try {
    const chars = project.bible.characters
      .map((c: any) => `${c.name}｜${c.role || ''}｜想要:${c.want || ''}｜创伤:${c.wound || ''}`)
      .join('\n');

    const system = `你是小说连续性审校，只做一件事：把人物之间的**有向关系**抽成 JSON 数组。
不评价、不改写，只做事实抽取。输出必须是 JSON 数组，不要任何其他文字。`;

    const user = `【人物设定】
${chars}

【已写正文】
${chapters}

请抽出所有人物之间的有向关系，输出：
[{"from":"人物A","to":"人物B","kind":"ally|enemy|master|debt|unknows|broken","note":"A 对 B 是什么关系，依据是什么"}]

要求：
- 关系是**有向的**：A → B 读作「A 对 B」。两边不一样就分别写两条。
- 只写正文里真的体现出来的；设定里写明但正文还没写到的也保留，note 里注明「（设定）」。
- 已经结束的关系不要写。
- kind 只能取 ally / enemy / master / debt / unknows / broken 之一，含义如下：
    · ally    A 对 B 是同盟、互相支持
    · enemy   A 对 B 是敌对、互相提防
    · master  A 是 B 的上级 / 有管辖或支配权（注意方向：A 是上级）
    · debt    A 欠 B 人情，或有未偿的债 / 被 B 拿捏
    · unknows A 对 B 关系未明、互不相识、或尚未表态
    · broken  A 与 B 已经决裂
  拿不准时用 unknows，**不要**把上下级写成 unknows。
- 最多 12 条。`;

    const raw = await complete(system, user, { label: 'relations rebuild' });
    const parsed = extractJSON(raw);
    const list = Array.isArray(parsed) ? parsed : [];
    const rebuilt = list
      .filter((r: any) => r && r.from && r.to)
      .map((r: any) => ({
        from: r.from,
        to: r.to,
        kind: REL_LABELS[r.kind] ? r.kind : 'unknows',
        label: r.note || r.label || '',
        since: 1,
        until: null,
      }));

    if (!rebuilt.length) throw new Error('没有抽出任何关系');

    project.memory.relations = rebuilt;
    project.memory.updatedAt = new Date().toISOString();
    project.log.push({
      ts: new Date().toISOString(),
      stage: 'manual',
      action: '重扫人物关系',
      detail: `从已写的 ${project.chapters.length} 章里抽出 ${rebuilt.length} 条有向关系`,
    });
    saveStore(store);

    res.json({ ok: true, relations: rebuilt, summary: projectSummary(project) });
  } catch (e: any) {
    console.error('[Novel] 重扫关系失败:', e);
    res.status(500).json({ error: e?.message || '重扫关系失败' });
  }
});

/** 设定档案 */
router.get('/bible', (_req, res) => {
  const project = activeProject(loadStore());
  if (!project) return res.status(404).json({ error: '还没有小说工程' });
  res.json({ title: project.title, bible: project.bible, outline: project.outline });
});

/** 记忆卡：canon / state / hooks / relations + 体检 */
router.get('/memory', (_req, res) => {
  const project = activeProject(loadStore());
  if (!project) return res.status(404).json({ error: '还没有小说工程' });
  const mem = project.memory;
  if (!mem) return res.status(404).json({ error: '记忆层还没初始化' });
  const chNum = project.currentChapter;
  res.json({
    chapterNum: chNum,
    canon: mem.canon,
    state: mem.state,
    hooks: mem.hooks.map((h: any) => ({ ...h, pressure: hookPressure(h, chNum) })),
    relations: mem.relations,
    timeline: mem.timeline,
    health: memoryHealth(mem, chNum),
    selection: selectHooks(mem, chNum),
    card: buildMemoryCard(mem, chNum),
  });
});

/** 下一章上下文：把记忆卡组装成可以直接喂给模型的 prompt */
router.get('/next', (_req, res) => {
  const project = activeProject(loadStore());
  if (!project) return res.status(404).json({ error: '还没有小说工程' });
  const chNum = project.currentChapter;
  const outlineItem = project.outline.find((o: any) => o.num === chNum) || null;
  const prompt = buildDraftPrompt(project, chNum);
  res.json({
    chapterNum: chNum,
    outlineItem,
    hasOutline: !!outlineItem,
    system: prompt.system,
    user: prompt.user,
    memoryCard: project.memory ? buildMemoryCard(project.memory, chNum) : null,
  });
});

/**
 * 存稿 + 降 AI 味 + 回收 + 质检（一次做完，返回「本章自动做了什么」）
 *
 * 顺序很关键：降味 → 存章 → 回收 → 质检。
 *   回收必须跑在降味**之后** —— 否则回收抽的是被改掉的那版文本，
 *   记忆层记下的状态和最终稿子对不上。
 */
router.post('/commit', async (req, res) => {
  const { content, runHarvest = true, autoDeAI = true } = req.body || {};
  if (!content || !String(content).trim()) {
    return res.status(400).json({ error: '正文不能为空' });
  }
  const store = loadStore();
  const project = activeProject(store);
  if (!project) return res.status(404).json({ error: '还没有小说工程' });

  const sse = wantsSse(req) ? openSse(res) : null;
  const emit: Emit = (message, step, extra) => {
    console.log(`[Novel] 存稿 · ${message}`);
    sse?.emit(message, step, extra);
  };

  const chNum = project.currentChapter;
  let text = String(content).trim();

  try {
    const outlineItem = project.outline.find((o: any) => o.num === chNum);

    /* ——— 0. 自动降 AI 味（定点重写，不改剧情） ——— */
    let deAI: DeAIResult | null = null;
    if (autoDeAI) {
      emit('正在体检 AI 痕迹…', 'deai');
      const pre = lintReport(text);
      if (needsDeAI(pre)) {
        emit(`AI 痕迹 ${pre.score} 分（${pre.label}），开始定点改写…`, 'deai');
        deAI = await runDeAIPass(text, { threshold: 32, maxRounds: 2, emit });
        if (deAI.applied) {
          text = deAI.text;
          emit(`降味完成：${deAI.before} → ${deAI.after} 分（改了 ${deAI.rounds} 轮）`, 'deai');
        } else {
          emit(`改写没有变好（${deAI.before} → ${deAI.after}），保留原稿`, 'deai');
        }
      } else {
        deAI = {
          text,
          before: pre.score,
          after: pre.score,
          applied: false,
          rounds: 0,
          trace: [{ round: 0, score: pre.score }],
        };
        emit(`AI 痕迹只有 ${pre.score} 分，够自然，跳过改写`, 'deai');
      }
    }

    /* ——— 1. 存章 ——— */
    const chapter = {
      num: chNum,
      title: outlineItem?.title || `第 ${chNum} 章`,
      content: text,
      summary: makeSummary(text),
      status: 'drafted',
      wordCount: text.replace(/\s/g, '').length,
      committedAt: new Date().toISOString(),
    };
    const existingIdx = project.chapters.findIndex((c: any) => c.num === chNum);
    if (existingIdx >= 0) project.chapters[existingIdx] = chapter;
    else project.chapters.push(chapter);

    /* ——— 2. 回收关卡：抽状态变更 → 写回记忆 ——— */
    let notes: string[] = [];
    let updates: any[] = [];
    if (runHarvest && project.memory) {
      emit('正在回收本章状态变更（人物 / 关系 / 钩子）…', 'harvest');
      try {
        const hp = buildHarvestPrompt(project, chNum);
        const raw = await complete(hp.system, hp.user, { label: `harvest ch${chNum}`, maxTokens: 2000 });
        const parsed = parseJSON(raw);
        updates = Array.isArray(parsed) ? parsed : parsed?.updates ?? [];

        // 同一章里既埋又收 = 误报。埋下的坑读者还没机会惦记，谈不上回收。
        // 提示词里已经写了这条，但模型不一定听，所以这里再机械拦一道。
        const plantedThisChapter = new Set<string>([
          ...(project.memory.hooks || [])
            .filter((h: any) => h.plantedIn === chNum)
            .map((h: any) => String(h.title || '')),
          ...updates.filter((u: any) => u?.kind === 'foreshadow_plant').map((u: any) => String(u.target || '')),
        ]);
        const dropped: string[] = [];
        const usable = updates.filter((u: any) => {
          if (u?.kind === 'foreshadow_pay' && plantedThisChapter.has(String(u.target || ''))) {
            dropped.push(String(u.target));
            return false;
          }
          return true;
        });
        updates = usable;
        notes = applyStateUpdate(project.memory, usable, chNum);
        if (dropped.length) {
          notes.push(`忽略 ${dropped.length} 条同章回收（本章刚埋，还谈不上收）：${dropped.join('、')}`);
        }
      } catch (e: any) {
        notes = [`回收失败（不影响存稿）：${e?.message || e}`];
      }

      // 确定性兜底：模型漏报的回收，这里按「标题逐字出现」补上。
      // 不做这一步的话，钩子会一直开着，体检页永远在喊「拖太久」。
      const auto = autoCloseHooksByText(project, chNum, text);
      if (auto.length) notes = notes.concat(auto);

      // 章节摘要进记忆层，供前情提要用。
      // tail 是「上一章结尾原文」—— 记忆卡里保语感的那一段就靠它，
      // 不给的话 buildMemoryCard 的 lastChapter 永远是空串，衔接机制等于没生效。
      const existingMemIdx = project.memory.chapters.findIndex((c: any) => c.num === chNum);
      const memChapter = {
        num: chNum,
        title: chapter.title,
        summary: chapter.summary,
        tail: text.slice(-1200),
        words: chapter.wordCount,
        ts: new Date().toISOString(),
      };
      if (existingMemIdx >= 0) project.memory.chapters[existingMemIdx] = memChapter;
      else project.memory.chapters.push(memChapter);
      project.memory.updatedAt = new Date().toISOString();
    }

    /* ——— 3. 质检 ——— */
    const report = lintReport(text);
    const consistency = project.memory ? validate(project.memory, chNum) : null;

    /* ——— 4. 推进 ——— */
    project.currentChapter = chNum + 1;
    project.updatedAt = new Date().toISOString();

    const closedHooks = notes.filter((n) => n.startsWith('回收：') || n.startsWith('自动回收钩子'));
    project.log.push({
      ts: new Date().toISOString(),
      stage: 'auto',
      action: `第 ${chNum} 章完成`,
      detail:
        `${chapter.wordCount} 字｜回收 ${notes.length} 项（钩子 ${closedHooks.length} 个）｜` +
        `AI 痕迹 ${report.score} 分（${report.label}）` +
        (deAI?.applied ? `｜已自动降味 ${deAI.before}→${deAI.after}` : ''),
    });
    saveStore(store);

    const payload = {
      chapter: { num: chapter.num, title: chapter.title, wordCount: chapter.wordCount },
      notes,
      updates,
      closedHooks,
      lint: report,
      deAI: deAI
        ? { before: deAI.before, after: deAI.after, applied: deAI.applied, rounds: deAI.rounds, trace: deAI.trace }
        : null,
      consistency,
      issues: consistency?.issues ?? [],
      fatalCount: consistency?.fatalCount ?? 0,
      guardPrompt: consistency?.issues?.length ? validatePrompt(consistency.issues) : '',
      summary: projectSummary(project),
      nextChapter: project.currentChapter,
    };

    if (sse) {
      sse.done(payload);
      sse.close();
    } else {
      res.json({ ok: true, ...payload });
    }
  } catch (e: any) {
    console.error('[Novel] 存稿失败:', e);
    const msg = e?.message || '存稿失败';
    if (sse) {
      sse.fail(msg);
      sse.close();
    } else {
      res.status(500).json({ error: msg });
    }
  }
});

/**
 * 手动降 AI 味：只体检 + 改写，不存稿。
 * 给「我已经存过稿了，但检测没过，再帮我压一压」这个场景用。
 */
router.post('/deai', async (req, res) => {
  const { text, rounds = 2 } = req.body || {};
  if (!text || !String(text).trim()) return res.status(400).json({ error: '文本不能为空' });

  const sse = wantsSse(req) ? openSse(res) : null;
  const emit: Emit = (m, s, e) => sse?.emit(m, s, e);

  try {
    const r = await runDeAIPass(String(text), { threshold: 32, maxRounds: Math.max(1, Math.min(4, Number(rounds) || 2)), emit });
    const payload = {
      text: r.text,
      before: r.before,
      after: r.after,
      applied: r.applied,
      rounds: r.rounds,
      trace: r.trace,
      lint: lintReport(r.text),
    };
    if (sse) {
      sse.done(payload);
      sse.close();
    } else {
      res.json({ ok: true, ...payload });
    }
  } catch (e: any) {
    const msg = e?.message || '降味失败';
    if (sse) {
      sse.fail(msg);
      sse.close();
    } else {
      res.status(500).json({ error: msg });
    }
  }
});

/** 只做 AI 痕迹体检（不存稿） */
router.post('/lint', (req, res) => {
  const { text } = req.body || {};
  if (!text) return res.status(400).json({ error: '文本不能为空' });
  res.json({ ok: true, ...lintReport(String(text)) });
});

/** 一致性校验 */
router.get('/validate', (_req, res) => {
  const project = activeProject(loadStore());
  if (!project) return res.status(404).json({ error: '还没有小说工程' });
  const chNum = project.currentChapter;
  const report = project.memory
    ? validate(project.memory, chNum)
    : { issues: [], fatalCount: 0, warnCount: 0, ok: true, stats: null };
  res.json({
    chapterNum: chNum,
    ...report,
    prompt: report.issues.length ? validatePrompt(report.issues) : '',
  });
});

/** 关系图谱 */
router.get('/graph', (_req, res) => {
  const project = activeProject(loadStore());
  if (!project?.memory) return res.status(404).json({ error: '还没有小说工程' });
  const mem = project.memory;
  const chNum = project.currentChapter;
  const nodes = mem.state.characters.map((c: any) => ({
    id: c.name,
    name: c.name,
    alive: c.alive !== false,
    where: c.where,
    faction: c.faction || '',
    lastSeenIn: c.lastSeenIn,
  }));
  const links = mem.relations.map((r: any) => ({
    source: r.from,
    target: r.to,
    kind: r.kind,
    label: REL_LABELS[r.kind] || r.kind,
    note: r.label,
    since: r.since,
    until: r.until,
    active: r.until == null,
  }));
  res.json({ chapterNum: chNum, nodes, links, timeline: mem.timeline });
});

/** 钩子操作：收了 / 不收了 */
router.post('/hook', (req, res) => {
  const { id, action, closedBy, closedIn } = req.body || {};
  const store = loadStore();
  const project = activeProject(store);
  if (!project?.memory) return res.status(404).json({ error: '还没有小说工程' });
  const hook = project.memory.hooks.find((h: any) => h.id === id);
  if (!hook) return res.status(404).json({ error: '找不到这个钩子' });

  if (action === 'close') {
    hook.status = HOOK_STATE.closed;
    hook.closedIn = closedIn ?? project.currentChapter;
    hook.closedBy = closedBy || '手动标记为已回收';
  } else if (action === 'drop') {
    hook.status = HOOK_STATE.dropped;
    hook.closedIn = closedIn ?? project.currentChapter;
    hook.closedBy = closedBy || '手动放弃';
  } else if (action === 'reopen') {
    hook.status = HOOK_STATE.open;
    delete hook.closedIn;
    delete hook.closedBy;
  } else {
    return res.status(400).json({ error: '未知操作' });
  }
  project.memory.updatedAt = new Date().toISOString();
  saveStore(store);
  res.json({ ok: true, summary: projectSummary(project) });
});

/** 章节列表 / 单章 */
router.get('/chapters', (_req, res) => {
  const project = activeProject(loadStore());
  if (!project) return res.status(404).json({ error: '还没有小说工程' });
  res.json({
    chapters: project.chapters.map((c: any) => ({
      num: c.num, title: c.title, wordCount: c.wordCount, summary: c.summary, status: c.status,
    })),
    currentChapter: project.currentChapter,
  });
});

router.get('/chapter/:num', (req, res) => {
  const project = activeProject(loadStore());
  if (!project) return res.status(404).json({ error: '还没有小说工程' });
  const num = Number(req.params.num);
  const chapter = project.chapters.find((c: any) => c.num === num);
  if (!chapter) return res.status(404).json({ error: `第 ${num} 章还没写` });
  res.json({ ...chapter, lint: lintReport(chapter.content) });
});

/** 日志（本章自动做了什么） */
router.get('/log', (_req, res) => {
  const project = activeProject(loadStore());
  if (!project) return res.status(404).json({ error: '还没有小说工程' });
  res.json({ log: project.log.slice(-30).reverse(), pendingConflicts: pendingConflicts(project) });
});

/** 切书 / 删书 */
router.post('/select', (req, res) => {
  const { id } = req.body || {};
  const store = loadStore();
  if (!store.projects.find((p) => p.id === id)) return res.status(404).json({ error: '找不到这本' });
  store.activeId = id;
  saveStore(store);
  res.json({ ok: true, summary: projectSummary(activeProject(store)) });
});

router.post('/delete', (req, res) => {
  const { id } = req.body || {};
  const store = loadStore();
  store.projects = store.projects.filter((p) => p.id !== id);
  if (store.activeId === id) store.activeId = store.projects[0]?.id ?? null;
  saveStore(store);
  res.json({ ok: true });
});

/** 导出：全文 / 设定档案 / 质量报告 */
router.get('/export', (req, res) => {
  const project = activeProject(loadStore());
  if (!project) return res.status(404).json({ error: '还没有小说工程' });
  const kind = String(req.query.kind || 'full');
  const b = project.bible;
  let text = '';

  if (kind === 'bible') {
    text = [
      `# ${project.title} · 设定档案`,
      '',
      `> ${b.premise}`,
      '',
      '## 世界规则',
      ...b.world.map((w: any) => `- **${w.name}**：${w.rule}`),
      '',
      '## 人物',
      ...b.characters.map((c: any) => `- **${c.name}**（${c.role || ''}）\n  - 想要：${c.want}\n  - 创伤：${c.wound}\n  - 口吻：${c.voice}`),
      '',
      '## 伏笔',
      ...b.foreshadows.map((f: any) => `- ${f.title}：${f.note || ''}`),
      '',
      '## 支线',
      ...b.threads.map((t: any) => `- ${t.title}：${t.note || ''}`),
      '',
      `## 大纲（共 ${project.outline?.length ?? 0} 章）`,
      ...(project.outline ?? []).flatMap((o: any) => [
        `### 第 ${o.num} 章　${o.title}`,
        ...(o.goal ? [`- 目标：${o.goal}`] : []),
        ...((o.beats ?? []) as string[]).map((x) => `  - ${x}`),
        '',
      ]),
    ].join('\n');
  } else if (kind === 'report') {
    const st = projectStats(project);
    const health = project.memory ? memoryHealth(project.memory, project.currentChapter) : null;
    text = [
      `# ${project.title} · 质量报告`,
      '',
      `- 已写：${st.chapters} 章 / ${st.words} 字`,
      `- 钩子：开着 ${health?.openHooks ?? 0} 个，收了 ${health?.closedHooks ?? 0} 个，拖太久 ${health?.overdueHooks ?? 0} 个`,
      `- 平均回收周期：${health?.avgHookLife ?? '—'} 章`,
      '',
      '## 各章 AI 痕迹',
      ...project.chapters.map((c: any) => `- 第 ${c.num} 章 ${c.title}：${lintReport(c.content).score} 分（${lintReport(c.content).label}）· ${c.wordCount} 字`),
    ].join('\n');
  } else if (kind === 'outline') {
    // 大纲单独可导：建完书第一件想看到的东西就是它，不该只藏在 novel.json 里
    const outline: any[] = project.outline ?? [];
    text = [
      `# ${project.title} · 大纲（共 ${outline.length} 章）`,
      '',
      `> ${b.premise}`,
      '',
      '| 章 | 标题 | 目标 |',
      '|---|---|---|',
      ...outline.map((o: any) => `| ${o.num} | ${o.title} | ${String(o.goal || '').replace(/\|/g, '／')} |`),
      '',
      ...outline.flatMap((o: any) => [
        `## 第 ${o.num} 章　${o.title}`,
        ...(o.goal ? ['', `**目标**：${o.goal}`] : []),
        ...((o.beats ?? []) as string[]).map((x: string) => `- ${x}`),
        '',
      ]),
    ].join('\n');
  } else {
    text = [
      `# ${project.title}`,
      '',
      `> ${b.premise}`,
      '',
      ...project.chapters
        .sort((a: any, b2: any) => a.num - b2.num)
        .map((c: any) => `## 第 ${c.num} 章　${c.title}\n\n${c.content}\n`),
    ].join('\n');
  }

  res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(project.title)}-${kind}.md"`);
  res.send(text);
});

export default router;
