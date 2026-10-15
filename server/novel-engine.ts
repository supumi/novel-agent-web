/**
 * novel-forge 引擎适配层
 *
 * 小说创作助手真正的「本事」不在提示词里，而在 novel-forge 那套纯 JS 引擎：
 *   记忆四层 + 钩子压力 + 一致性七类硬伤 + AI 痕迹检测
 * 这里把它整体引进来复用，而不是在 Web 端重新实现一遍。
 *
 * 引擎文件是**内联**在本目录 `engine/` 下的（从上游 novel-forge 原样拷贝），
 * 这样整个 novel-agent-web 目录是自包含的 —— 发布时只上传这一个目录就够了。
 * 上游更新时，重新拷贝这 5 个 .mjs 即可，不需要改代码。
 *
 * 这些 .mjs 没有类型声明，所以在唯一入口处做一次「去类型化」，
 * 其余业务代码就能拿到统一的类型。
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

// @ts-ignore novel-forge 的引擎是纯 JS，无类型声明
import * as memoryMod from "./engine/memory.mjs";
// @ts-ignore
import * as consistencyMod from "./engine/consistency.mjs";
// @ts-ignore
import * as lintMod from "./engine/lint.mjs";
// @ts-ignore
import * as styleMod from "./engine/style.mjs";
// @ts-ignore
import * as modelMod from "./engine/model.mjs";

const memory = memoryMod as any;
const consistency = consistencyMod as any;
const lintModAny = lintMod as any;
const style = styleMod as any;
const model = modelMod as any;

/** 钩子生命周期 */
export const HOOK_STATE = memory.HOOK_STATE as { open: string; closed: string; dropped: string };
/** 关系类型中文标签 */
export const REL_LABELS = memory.REL_LABELS as Record<string, string>;
/** 同时开着的钩子上限 */
export const MAX_OPEN_HOOKS = memory.MAX_OPEN_HOOKS as number;

export interface HookPressure {
  age: number;
  level: 'cold' | 'warm' | 'due' | 'overdue' | 'rotten';
  weight: number;
}

/** 钩子压力：埋下后过了几章 → 该不该收 */
export const hookPressure = memory.hookPressure as (
  hook: any,
  currentChapter: number,
) => HookPressure | null;

/** 选出本章该收/该埋的钩子 */
export const selectHooks = memory.selectHooks as (memory: any, currentChapter: number) => {
  due: any[];
  plant: 'yes' | 'no';
  overdue: string[];
  openTotal: number;
  overLimit: boolean;
  maxOpen: number;
};

/** 构造本章记忆卡（塞进 prompt 的核心） */
export const buildMemoryCard = memory.buildMemoryCard as (memory: any, chapterNum: number) => any;

/** 章节摘要 */
export const makeSummary = memory.makeSummary as (content: string) => string;

/** 把「状态变更」写回记忆层 */
export const applyStateUpdate = memory.applyStateUpdate as (
  memory: any,
  updates: any[],
  chapterNum: number,
) => string[];

/** 从设定初始化记忆层 */
export const initMemory = memory.initMemory as (bible: any) => any;

/** 记忆体检：该补哪里 */
export const memoryHealth = memory.memoryHealth as (memory: any, currentChapter: number) => {
  openHooks: number;
  closedHooks: number;
  overdueHooks: number;
  overdueList: any[];
  openThreads: number;
  avgHookLife: number | null;
  lastChapterNum: number;
};

export interface ConsistencyIssue {
  severity: 'fatal' | 'warn' | 'info';
  kind?: string;
  text: string;
  fix?: string;
  [k: string]: any;
}

export interface ConsistencyReport {
  issues: ConsistencyIssue[];
  fatalCount: number;
  warnCount: number;
  ok: boolean;
  stats: {
    characters: number;
    alive: number;
    dead: number;
    factions: number;
    relations: number;
    byFaction: Record<string, string[]>;
  };
}

/** 一致性校验：七类硬伤 */
export const validate = consistency.validate as (
  memory: any,
  currentChapter: number,
) => ConsistencyReport;
export const validatePrompt = consistency.validatePrompt as (issues: ConsistencyIssue[]) => string;
export const SEVERITY = consistency.SEVERITY as Record<string, string>;

/** AI 痕迹检测 */
export const lint = lintModAny.lint as (text: string) => any;
export const lintScore = lintModAny.score as (text: string) => number;
export const LINT_RULES = lintModAny.RULE_LIST as Array<{ id: string; label: string; kind: string }>;
export const antiAIPrompt = lintModAny.antiAIPrompt as () => string;

/** 写作风格示范与自查清单 */
export const styleGuide = style.styleGuide as (full?: boolean) => string;
export const SELF_CHECK = style.SELF_CHECK as string;

/** 数据模型 */
export const newProject = model.newProject as (seed?: string) => any;
export const projectStats = model.stats as (project: any) => {
  words: number;
  chapters: number;
  committed: number;
  foreshadowsPlanted: number;
  foreshadowsPaid: number;
  foreshadowRatio: number;
  openThreads: number;
  chars: number;
};
export const pendingConflicts = model.pendingConflicts as (project: any) => any[];
export const STAGES = model.STAGES as Array<{ key: string; index: number; name: string; purpose: string }>;

export const engine = {
  memory,
  consistency,
  lint: lintModAny,
  style,
  model,
};
