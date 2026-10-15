import { useState, useEffect, useCallback } from 'react';
import { apiFetch, apiStream } from '../lib/api';

/* ============ 类型 ============ */

export interface NovelHook {
  id: string;
  title: string;
  detail?: string;
  payPlan?: string;
  plantedIn: number;
  status: 'open' | 'closed' | 'dropped';
  closedIn?: number;
  closedBy?: string;
  pressure?: { age: number; level: string; weight: number } | null;
  pressureLabel?: string | null;
}

export interface NovelSummary {
  id: string;
  title: string;
  seed: string;
  stage: string;
  currentChapter: number;
  outlineTotal: number;
  stats: {
    words: number;
    chapters: number;
    committed: number;
    foreshadowsPlanted: number;
    foreshadowsPaid: number;
    foreshadowRatio: number;
    openThreads: number;
    chars: number;
  };
  health: {
    openHooks: number;
    closedHooks: number;
    overdueHooks: number;
    overdueList: NovelHook[];
    openThreads: number;
    avgHookLife: number | null;
    lastChapterNum: number;
  } | null;
  hooks: NovelHook[];
  selection: { due: NovelHook[]; plant: string; overdue: string[]; openTotal: number; overLimit: boolean; maxOpen: number } | null;
  maxOpenHooks: number;
  relLabels: Record<string, string>;
}

export interface LintHit {
  rule: string;
  label: string;
  severity: string;
  text: string;
  fix: string;
  line: number | null;
  col: number | null;
  /** 段落序号（从 0 开始），用于定位 */
  para?: number;
  /** lexical 词表命中 / rhythm 统计命中 */
  source?: 'lexical' | 'rhythm';
}

export interface LintReport {
  score: number;
  level: 'obvious' | 'suspect' | 'mild' | 'clean';
  label: string;
  hits: LintHit[];
  /** 统计节奏维度（0–100），过朱雀这类检测器主要看这个 */
  rhythm?: number;
  /** 用词维度（0–100） */
  lexical?: number;
  metrics?: {
    chars: number;
    sentences: number;
    paragraphs: number;
    avgSentenceLen: number;
    sentenceCv: number;
    shortRatio: number;
    longRatio: number;
    paraCv: number;
    deRatio: number;
    hitCount: number;
  };
  stats?: any;
  ruleCount: number;
}

export interface ConsistencyIssue {
  severity: 'fatal' | 'warn' | 'info';
  kind?: string;
  text: string;
  fix?: string;
}

/** 存稿时自动降 AI 味的结果 */
export interface DeAIReport {
  before: number;
  after: number;
  /** 是否真的改动了正文（没改说明本来就不脏，或改写没变好） */
  applied: boolean;
  rounds: number;
  trace: Array<{ round: number; score: number }>;
}

export interface CommitResult {
  ok: boolean;
  chapter: { num: number; title: string; wordCount: number };
  notes: string[];
  /** 本章被判定为「已回收」的钩子（含模型漏报、由兜底补上的） */
  closedHooks?: string[];
  lint: LintReport;
  deAI: DeAIReport | null;
  consistency: {
    issues: ConsistencyIssue[];
    fatalCount: number;
    warnCount: number;
    ok: boolean;
    stats: any;
  } | null;
  fatalCount: number;
  summary: NovelSummary;
  nextChapter: number;
}

/** 长任务进度回调：建书 / 存稿时服务端会推阶段消息 */
export type ProgressFn = (message: string, step?: string) => void;

export interface NextChapterContext {
  chapterNum: number;
  outlineItem: { num: number; title: string; goal?: string; beats?: string[] } | null;
  hasOutline: boolean;
  system: string;
  user: string;
}

export interface NovelGraph {
  chapterNum: number;
  nodes: Array<{ id: string; name: string; alive: boolean; where?: string; faction?: string; lastSeenIn?: number }>;
  links: Array<{ source: string; target: string; kind: string; label: string; note?: string; since?: number; until?: number | null; active: boolean }>;
}

export interface NovelLogEntry {
  ts: string;
  stage: string;
  action: string;
  detail: string;
}

export interface NovelProjectBrief {
  id: string;
  title: string;
  chapters: number;
  active?: boolean;
}

async function jget<T>(url: string): Promise<T> {
  const r = await apiFetch(url);
  const j = await r.json();
  if (!r.ok) throw new Error((j as any)?.message || (j as any)?.error || `请求失败 (${r.status})`);
  return j as T;
}

async function jpost<T>(url: string, body?: unknown): Promise<T> {
  const r = await apiFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  const j = await r.json();
  if (!r.ok) throw new Error((j as any)?.message || (j as any)?.error || `请求失败 (${r.status})`);
  return j as T;
}

export function useNovel() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hasProject, setHasProject] = useState(false);
  const [summary, setSummary] = useState<NovelSummary | null>(null);
  const [projects, setProjects] = useState<NovelProjectBrief[]>([]);
  const [building, setBuilding] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const j = await jget<{ hasProject: boolean; summary?: NovelSummary; projects: NovelProjectBrief[] }>(
        '/api/novel/state',
      );
      setHasProject(j.hasProject);
      setSummary(j.summary ?? null);
      setProjects(j.projects || []);
      setError(null);
    } catch (e: any) {
      setError(e?.message || '读取小说工程失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  /**
   * 建书：一句创意 → 设定 + 大纲 + 记忆层。
   *
   * 走 SSE 而不是普通 POST：服务端是「1 次串行骨架 + 7 次并行展开」，
   * 要跑一两分钟。SSE 期间服务端会持续推阶段消息（骨架 → 展开 → 合并），
   * 既能实时显示进度，也保证连接不会被代理掐断。
   */
  const buildBook = useCallback(
    async (seed: string, chapterCount = 12, onProgress?: ProgressFn) => {
      setBuilding(true);
      setError(null);
      const box: { project?: NovelSummary; err?: string } = {};
      try {
        await apiStream('/api/novel/new', { seed, chapterCount }, (evt) => {
          if (evt.type === 'progress') onProgress?.(String(evt.message || ''), String(evt.step || ''));
          else if (evt.type === 'done') box.project = evt.project as NovelSummary;
          else if (evt.type === 'error') box.err = String(evt.error || '建书失败');
        });
        if (box.err) throw new Error(box.err);
        if (!box.project) throw new Error('建书没有返回结果，请重试');
        setHasProject(true);
        setSummary(box.project);
        await refresh();
        return box.project;
      } catch (e: any) {
        setError(e?.message || '建书失败');
        throw e;
      } finally {
        setBuilding(false);
      }
    },
    [refresh],
  );

  const nextChapter = useCallback(() => jget<NextChapterContext>('/api/novel/next'), []);
  const memory = useCallback(() => jget<any>('/api/novel/memory'), []);
  const bible = useCallback(() => jget<{ title: string; bible: any; outline: any[] }>('/api/novel/bible'), []);
  const validateNow = useCallback(() => jget<any>('/api/novel/validate'), []);
  const graph = useCallback(() => jget<NovelGraph>('/api/novel/graph'), []);

  /** 从设定 + 已写章节重扫人物关系 */
  const rebuildRelations = useCallback(
    () =>
      jpost<{ ok: boolean; relations: any[]; summary: NovelSummary }>('/api/novel/relations/rebuild').then((j) => {
        setSummary(j.summary);
        return j;
      }),
    [],
  );
  const log = useCallback(() => jget<{ log: NovelLogEntry[]; pendingConflicts: any[] }>('/api/novel/log'), []);
  const chapters = useCallback(() => jget<{ chapters: any[]; currentChapter: number }>('/api/novel/chapters'), []);
  const chapter = useCallback((num: number) => jget<any>(`/api/novel/chapter/${num}`), []);
  const lintText = useCallback((text: string) => jpost<LintReport & { ok: boolean }>('/api/novel/lint', { text }), []);

  /**
   * 存稿 + 自动降 AI 味 + 回收 + 质检。
   * 同样走 SSE —— 这一串要跑一两分钟，普通 POST 会被代理掐断。
   */
  const commit = useCallback(
    async (content: string, runHarvest = true, onProgress?: ProgressFn) => {
      const box: { result?: CommitResult; err?: string } = {};
      await apiStream('/api/novel/commit', { content, runHarvest }, (evt) => {
        if (evt.type === 'progress') onProgress?.(String(evt.message || ''), String(evt.step || ''));
        else if (evt.type === 'done') {
          const { type: _t, ...payload } = evt as any;
          box.result = payload as CommitResult;
        } else if (evt.type === 'error') box.err = String(evt.error || '存稿失败');
      });
      if (box.err) throw new Error(box.err);
      if (!box.result) throw new Error('存稿没有返回结果，请重试');
      setSummary(box.result.summary);
      return box.result;
    },
    [],
  );

  /** 手动降 AI 味：只体检 + 定点改写，不存稿 */
  const deaiText = useCallback(async (text: string, onProgress?: ProgressFn) => {
    const box: { result?: any; err?: string } = {};
    await apiStream('/api/novel/deai', { text }, (evt) => {
      if (evt.type === 'progress') onProgress?.(String(evt.message || ''), String(evt.step || ''));
      else if (evt.type === 'done') {
        const { type: _t, ...payload } = evt as any;
        box.result = payload;
      } else if (evt.type === 'error') box.err = String(evt.error || '降味失败');
    });
    if (box.err) throw new Error(box.err);
    if (!box.result) throw new Error('降味没有返回结果，请重试');
    return box.result as {
      text: string;
      before: number;
      after: number;
      applied: boolean;
      rounds: number;
      trace: Array<{ round: number; score: number }>;
      lint: LintReport;
    };
  }, []);

  const hookAction = useCallback(
    async (id: string, action: 'close' | 'drop' | 'reopen', closedBy?: string) => {
      const j = await jpost<{ ok: boolean; summary: NovelSummary }>('/api/novel/hook', { id, action, closedBy });
      setSummary(j.summary);
      return j;
    },
    [],
  );

  const selectProject = useCallback(
    async (id: string) => {
      const j = await jpost<{ ok: boolean; summary: NovelSummary }>('/api/novel/select', { id });
      setSummary(j.summary);
      await refresh();
    },
    [refresh],
  );

  /** 让模型现想几条创意种子（不想用预置灵感池时） */
  const inspire = useCallback(
    (tag?: string, avoid: string[] = []) =>
      jpost<{ ok: boolean; seeds: Array<{ id: string; tag: string; seed: string }> }>('/api/novel/inspire', {
        tag,
        count: 5,
        avoid,
      }),
    [],
  );

  const deleteProject = useCallback(
    async (id: string) => {
      await jpost('/api/novel/delete', { id });
      await refresh();
    },
    [refresh],
  );

  return {
    loading,
    error,
    hasProject,
    summary,
    projects,
    building,
    refresh,
    buildBook,
    nextChapter,
    memory,
    bible,
    validateNow,
    graph,
    rebuildRelations,
    log,
    chapters,
    chapter,
    lintText,
    commit,
    deaiText,
    hookAction,
    selectProject,
    deleteProject,
    inspire,
  };
}
