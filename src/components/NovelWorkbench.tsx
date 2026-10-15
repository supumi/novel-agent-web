import { useState, useEffect, useCallback } from 'react';
import { Button, Input, Textarea, Tabs, Tag, Loading, Select, MessagePlugin } from 'tdesign-react';
import {
  Sparkles,
  BookOpen,
  Feather,
  Anchor,
  ShieldCheck,
  ScanLine,
  GitFork,
  ScrollText,
  Check,
  X,
  RotateCcw,
  Download,
  Trash2,
  Loader2,
  AlertTriangle,
  ChevronDown,
  FolderOpen,
  Lightbulb,
  RefreshCw,
  Wand2,
  ListOrdered,
  Users,
} from 'lucide-react';
import type { useNovel, NovelSummary, NovelHook, LintReport, ConsistencyIssue, NovelGraph, NovelLogEntry } from '../hooks/useNovel';
import {
  INSPIRATION_TAGS,
  filterInspirations,
  sampleInspirations,
  type Inspiration,
  type InspirationTag,
} from '../data/inspirations';

const C = {
  text: 'var(--td-text-color-primary)',
  sub: 'var(--td-text-color-secondary)',
  dim: 'var(--td-text-color-placeholder)',
  card: 'var(--td-bg-color-component)',
  container: 'var(--td-bg-color-container)',
  brand: 'var(--td-brand-color)',
  brandLight: 'var(--td-brand-color-light)',
  line: 'var(--td-component-stroke)',
};

const PRESSURE_STYLE: Record<string, { bg: string; fg: string; label: string }> = {
  cold: { bg: 'rgba(148,163,184,0.16)', fg: '#64748b', label: '刚埋' },
  warm: { bg: 'rgba(59,130,246,0.14)', fg: '#2563eb', label: '正常' },
  due: { bg: 'rgba(245,158,11,0.16)', fg: '#d97706', label: '该收' },
  overdue: { bg: 'rgba(249,115,22,0.18)', fg: '#ea580c', label: '拖太久' },
  rotten: { bg: 'rgba(239,68,68,0.16)', fg: '#dc2626', label: '该处理' },
};

const LINT_STYLE: Record<string, { fg: string; bg: string }> = {
  clean: { fg: '#16a34a', bg: 'rgba(22,163,74,0.12)' },
  mild: { fg: '#65a30d', bg: 'rgba(101,163,13,0.12)' },
  suspect: { fg: '#d97706', bg: 'rgba(217,119,6,0.14)' },
  obvious: { fg: '#dc2626', bg: 'rgba(220,38,38,0.12)' },
};

const SEVERITY_STYLE: Record<string, { fg: string; bg: string; label: string }> = {
  fatal: { fg: '#dc2626', bg: 'rgba(220,38,38,0.12)', label: '致命' },
  warn: { fg: '#d97706', bg: 'rgba(217,119,6,0.14)', label: '警告' },
  info: { fg: '#64748b', bg: 'rgba(148,163,184,0.16)', label: '提醒' },
};

function Pill({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <span
      className="inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium whitespace-nowrap"
      style={style}
    >
      {children}
    </span>
  );
}

/* ============ 建书表单 ============ */

function BuildForm({ novel }: { novel: ReturnType<typeof useNovel> }) {
  const [seed, setSeed] = useState('');
  const [chapterCount, setChapterCount] = useState(12);
  const [phase, setPhase] = useState('');
  const [tag, setTag] = useState<InspirationTag | '全部'>('全部');
  const [picked, setPicked] = useState<string | null>(null);
  const [cards, setCards] = useState<Inspiration[]>([]);
  const [aiSeeds, setAiSeeds] = useState<Inspiration[] | null>(null);
  const [thinking, setThinking] = useState(false);

  // 题材或 AI 结果变化时，重取一批灵感
  useEffect(() => {
    if (aiSeeds) return;
    setCards(sampleInspirations(filterInspirations(tag), 5));
  }, [tag, aiSeeds]);

  const shuffle = useCallback(() => {
    setAiSeeds(null);
    setPicked(null);
    setCards((prev) => sampleInspirations(filterInspirations(tag), 5, prev.map((c) => c.id)));
  }, [tag]);

  const askAI = useCallback(async () => {
    setThinking(true);
    try {
      const j = await novel.inspire(tag, cards.map((c) => c.seed));
      setAiSeeds(j.seeds as Inspiration[]);
      setPicked(null);
    } catch (e: any) {
      MessagePlugin.error(e?.message || '生成灵感失败');
    } finally {
      setThinking(false);
    }
  }, [novel, tag, cards]);

  const visible = aiSeeds ?? cards;

  const handleBuild = useCallback(async () => {
    if (!seed.trim()) {
      MessagePlugin.warning('先写一句创意种子，或从下面挑一个');
      return;
    }
    // 阶段文案由服务端推过来（骨架 → 并行展开 7 项 → 合并），不再靠猜时间
    setPhase('正在准备…');
    try {
      await novel.buildBook(seed.trim(), chapterCount, (msg) => setPhase(msg));
      MessagePlugin.success('书建好了');
    } catch (e: any) {
      MessagePlugin.error(e?.message || '建书失败');
    } finally {
      setPhase('');
    }
  }, [seed, chapterCount, novel]);

  return (
    <div className="w-full max-w-2xl mx-auto">
      <div className="text-center mb-6">
        <div
          className="w-16 h-16 rounded-2xl flex items-center justify-center mb-4 shadow-lg mx-auto"
          style={{ background: 'linear-gradient(135deg, #7c3aed, #a855f7)' }}
        >
          <Feather size={30} color="white" />
        </div>
        <h2 className="text-2xl font-semibold mb-2" style={{ color: C.text }}>
          开一本新书
        </h2>
        <p className="text-sm" style={{ color: C.sub }}>
          给一句创意，我来搭设定、排大纲、建记忆。之后你只需要按一个按钮写下一章。
        </p>
      </div>

      <div className="rounded-2xl p-5" style={{ backgroundColor: C.card }}>
        <label className="block text-sm font-medium mb-2" style={{ color: C.text }}>
          一句创意种子
        </label>
        <Textarea
          value={seed}
          onChange={(v) => {
            setSeed(v as string);
            setPicked(null);
          }}
          placeholder="例如：一个档案员发现自己的记忆被人系统性抹掉"
          autosize={{ minRows: 2, maxRows: 5 }}
          disabled={novel.building}
        />

        {/* 灵感池 */}
        <div className="mt-4">
          <div className="flex items-center gap-2 flex-wrap">
            <Lightbulb size={13} style={{ color: '#d97706' }} />
            <span className="text-xs" style={{ color: C.sub }}>
              想不出来？挑一个
            </span>
            <div className="flex-1" />
            <button
              className="text-xs inline-flex items-center gap-1 px-2 py-1 rounded-lg border"
              style={{ borderColor: C.line, color: C.sub }}
              onClick={shuffle}
              disabled={novel.building || thinking}
            >
              <RefreshCw size={11} /> 换一批
            </button>
            <button
              className="text-xs inline-flex items-center gap-1 px-2 py-1 rounded-lg border"
              style={{ borderColor: C.line, color: '#7c3aed' }}
              onClick={askAI}
              disabled={novel.building || thinking}
            >
              {thinking ? <Loader2 size={11} className="animate-spin" /> : <Wand2 size={11} />}
              {thinking ? '正在想…' : '让 AI 现想'}
            </button>
          </div>

          {/* 题材筛选 */}
          <div className="flex flex-wrap gap-1.5 mt-2.5">
            {(['全部', ...INSPIRATION_TAGS] as const).map((t) => {
              const on = tag === t;
              return (
                <button
                  key={t}
                  className="text-[11px] px-2 py-0.5 rounded-full transition-colors"
                  style={{
                    backgroundColor: on ? 'var(--td-brand-color)' : C.container,
                    color: on ? '#fff' : C.sub,
                    border: `1px solid ${on ? 'transparent' : C.line}`,
                  }}
                  onClick={() => {
                    setTag(t as InspirationTag | '全部');
                    setAiSeeds(null);
                    setPicked(null);
                  }}
                  disabled={novel.building}
                >
                  {t}
                </button>
              );
            })}
            {aiSeeds && (
              <span className="text-[11px] px-2 py-0.5 rounded-full" style={{ backgroundColor: 'rgba(124,58,237,0.12)', color: '#7c3aed' }}>
                AI 现想
              </span>
            )}
          </div>

          <div className="mt-2.5 space-y-1.5">
            {visible.map((c) => {
              const on = picked === c.id;
              return (
                <button
                  key={c.id}
                  className="w-full text-left rounded-lg px-3 py-2 text-xs transition-all"
                  style={{
                    backgroundColor: on ? C.brandLight : C.container,
                    border: `1px solid ${on ? C.brand : 'transparent'}`,
                    color: on ? C.brand : C.sub,
                  }}
                  onClick={() => {
                    setSeed(c.seed);
                    setPicked(c.id);
                  }}
                  disabled={novel.building}
                >
                  {c.seed}
                </button>
              );
            })}
          </div>
        </div>

        <div className="flex items-center gap-3 mt-4 pt-4 border-t" style={{ borderColor: C.line }}>
          <span className="text-sm" style={{ color: C.sub }}>
            规划章数
          </span>
          <Input
            type="number"
            value={String(chapterCount)}
            onChange={(v) => setChapterCount(Math.max(3, Math.min(30, Number(v) || 12)))}
            style={{ width: 88 }}
            disabled={novel.building}
          />
          <div className="flex-1" />
          <Button theme="primary" onClick={handleBuild} loading={novel.building} disabled={novel.building}>
            {novel.building ? '正在建书…' : '开始建书'}
          </Button>
        </div>

        {novel.building && (
          <div className="mt-3 text-xs flex items-start gap-2" style={{ color: C.dim }}>
            <Loader2 size={13} className="animate-spin shrink-0 mt-0.5" />
            <span>
              {phase || '正在生成…'}
              <br />
              先定骨架，再并行展开设定与大纲（7 路同时跑），约 1–2 分钟。请别关页面。
            </span>
          </div>
        )}
      </div>

      <div className="mt-5 grid grid-cols-3 gap-3 text-center">
        {[
          { icon: BookOpen, title: '四层记忆', desc: '设定 / 状态 / 钩子 / 近况' },
          { icon: Anchor, title: '钩子压力', desc: '埋了多久、该不该收' },
          { icon: ShieldCheck, title: '交稿体检', desc: '七类硬伤 + AI 痕迹' },
        ].map((f) => (
          <div key={f.title} className="rounded-xl p-3" style={{ backgroundColor: C.card }}>
            <f.icon size={16} style={{ color: C.brand, margin: '0 auto 6px' }} />
            <div className="text-xs font-medium" style={{ color: C.text }}>
              {f.title}
            </div>
            <div className="text-[11px] mt-0.5" style={{ color: C.dim }}>
              {f.desc}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ============ 设定 + 大纲 tab ============ */

/**
 * 建完书第一件想看到的东西就是大纲，之前它只躺在 novel.json 里没人看得见。
 * 这里把 /api/novel/bible 返回的设定档案与 12 章大纲直接摊开展示。
 */
function BibleTab({ novel, summary }: { novel: ReturnType<typeof useNovel>; summary: NovelSummary }) {
  const [data, setData] = useState<{ title: string; bible: any; outline: any[] } | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    novel
      .bible()
      .then((d) => alive && setData(d))
      .catch(() => {})
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [novel, summary.id]);

  if (loading) return <Loading loading text="读取设定与大纲…" />;
  if (!data) return <div className="text-sm" style={{ color: C.dim }}>设定还没生成。</div>;

  const b = data.bible || {};
  const outline: any[] = data.outline || [];

  return (
    <div className="space-y-5">
      {b.premise && (
        <div className="rounded-lg px-3 py-2.5 text-xs leading-relaxed" style={{ backgroundColor: C.brandLight, color: C.brand }}>
          {b.premise}
        </div>
      )}

      <div>
        <div className="text-xs font-medium mb-2 flex items-center gap-1.5" style={{ color: C.sub }}>
          <ListOrdered size={13} /> 大纲（共 {outline.length} 章）
        </div>
        <div className="space-y-1.5">
          {outline.map((o) => (
            <details key={o.num} className="rounded-lg px-3 py-2 text-xs" style={{ backgroundColor: C.card }}>
              <summary className="cursor-pointer flex items-center gap-2">
                <span style={{ color: C.dim }}>第 {o.num} 章</span>
                <span className="font-medium" style={{ color: C.text }}>
                  {o.title}
                </span>
              </summary>
              {o.goal ? (
                <div className="mt-1.5 leading-relaxed" style={{ color: C.sub }}>
                  <span style={{ color: C.dim }}>目标：</span>
                  {o.goal}
                </div>
              ) : null}
              {o.beats?.length ? (
                <ul className="mt-1.5 space-y-0.5 list-disc pl-4 leading-relaxed" style={{ color: C.sub }}>
                  {o.beats.map((x: string, i: number) => (
                    <li key={i}>{x}</li>
                  ))}
                </ul>
              ) : null}
            </details>
          ))}
          {!outline.length && (
            <div className="text-xs" style={{ color: C.dim }}>
              还没有大纲。
            </div>
          )}
        </div>
      </div>

      {b.world?.length ? (
        <div>
          <div className="text-xs font-medium mb-2 flex items-center gap-1.5" style={{ color: C.sub }}>
            <BookOpen size={13} /> 世界规则
          </div>
          <div className="space-y-1.5">
            {b.world.map((w: any, i: number) => (
              <div key={i} className="rounded-lg px-3 py-2 text-xs leading-relaxed" style={{ backgroundColor: C.card, color: C.text }}>
                <span className="font-medium">{w.name}</span>
                <span style={{ color: C.sub }}> — {w.rule}</span>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {b.characters?.length ? (
        <div>
          <div className="text-xs font-medium mb-2 flex items-center gap-1.5" style={{ color: C.sub }}>
            <Users size={13} /> 人物
          </div>
          <div className="space-y-1.5">
            {b.characters.map((c: any, i: number) => (
              <div key={i} className="rounded-lg px-3 py-2 text-xs" style={{ backgroundColor: C.card }}>
                <div className="flex items-center gap-2">
                  <span className="font-medium" style={{ color: C.text }}>
                    {c.name}
                  </span>
                  <span style={{ color: C.dim }}>{c.role}</span>
                </div>
                <div className="mt-1 leading-relaxed" style={{ color: C.sub }}>
                  {c.want ? (
                    <div>
                      <span style={{ color: C.dim }}>想要：</span>
                      {c.want}
                    </div>
                  ) : null}
                  {c.wound ? (
                    <div>
                      <span style={{ color: C.dim }}>创伤：</span>
                      {c.wound}
                    </div>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {b.foreshadows?.length ? (
        <div>
          <div className="text-xs font-medium mb-2 flex items-center gap-1.5" style={{ color: C.sub }}>
            <Lightbulb size={13} /> 伏笔
          </div>
          <div className="space-y-1.5">
            {b.foreshadows.map((f: any, i: number) => (
              <div key={i} className="rounded-lg px-3 py-2 text-xs leading-relaxed" style={{ backgroundColor: C.card }}>
                <span className="font-medium" style={{ color: C.text }}>
                  {f.title}
                </span>
                <span style={{ color: C.sub }}>：{f.note}</span>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {b.threads?.length ? (
        <div>
          <div className="text-xs font-medium mb-2 flex items-center gap-1.5" style={{ color: C.sub }}>
            <GitFork size={13} /> 支线
          </div>
          <div className="space-y-1.5">
            {b.threads.map((t: any, i: number) => (
              <div key={i} className="rounded-lg px-3 py-2 text-xs leading-relaxed" style={{ backgroundColor: C.card }}>
                <span className="font-medium" style={{ color: C.text }}>
                  {t.title}
                </span>
                <span style={{ color: C.sub }}>：{t.note}</span>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/* ============ 记忆 tab ============ */

function MemoryTab({ novel, summary }: { novel: ReturnType<typeof useNovel>; summary: NovelSummary }) {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    novel
      .memory()
      .then((d) => alive && setData(d))
      .catch(() => {})
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [novel, summary.currentChapter]);

  if (loading) return <Loading loading text="读取记忆卡…" />;
  if (!data) return <div className="text-sm" style={{ color: C.dim }}>记忆层还没初始化。</div>;

  return (
    <div className="space-y-4">
      <div>
        <div className="text-xs font-medium mb-2 flex items-center gap-1.5" style={{ color: C.sub }}>
          <BookOpen size={13} /> canon 硬设定（不可改）
        </div>
        <div className="space-y-1.5">
          {data.canon?.world?.map((w: any, i: number) => (
            <div key={i} className="rounded-lg px-3 py-2 text-xs" style={{ backgroundColor: C.card, color: C.text }}>
              <span className="font-medium">{w.name}</span>
              <span style={{ color: C.sub }}> — {w.rule}</span>
            </div>
          ))}
        </div>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {data.canon?.characters?.map((c: any, i: number) => (
            <Pill key={i} style={{ backgroundColor: C.brandLight, color: C.brand }}>
              {c.name}
            </Pill>
          ))}
        </div>
      </div>

      <div>
        <div className="text-xs font-medium mb-2" style={{ color: C.sub }}>
          时间 · {data.state?.clock}
        </div>
        <div className="space-y-1.5">
          {data.state?.characters?.map((c: any, i: number) => (
            <div key={i} className="rounded-lg px-3 py-2 text-xs" style={{ backgroundColor: C.card }}>
              <div className="flex items-center gap-2">
                <span className="font-medium" style={{ color: C.text }}>
                  {c.name}
                </span>
                {c.alive === false && <Pill style={{ backgroundColor: 'rgba(220,38,38,0.12)', color: '#dc2626' }}>已死亡</Pill>}
                <span style={{ color: C.dim }}>{c.where}</span>
              </div>
              <div className="mt-1" style={{ color: C.sub }}>
                {c.condition}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ============ 钩子 tab ============ */

function HooksTab({ novel, summary }: { novel: ReturnType<typeof useNovel>; summary: NovelSummary }) {
  const [busy, setBusy] = useState<string | null>(null);
  const hooks = summary.hooks || [];
  const open = hooks.filter((h) => h.status === 'open');
  const closed = hooks.filter((h) => h.status !== 'open');

  const act = async (id: string, action: 'close' | 'drop' | 'reopen') => {
    setBusy(id);
    try {
      await novel.hookAction(id, action);
    } catch (e: any) {
      MessagePlugin.error(e?.message || '操作失败');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 text-xs" style={{ color: C.sub }}>
        <span>
          开着 <b style={{ color: C.text }}>{open.length}</b> / {summary.maxOpenHooks}
        </span>
        {summary.selection?.overLimit && (
          <Pill style={{ backgroundColor: 'rgba(239,68,68,0.12)', color: '#dc2626' }}>
            <AlertTriangle size={11} /> 超量，先收坑再埋新坑
          </Pill>
        )}
        {summary.selection?.plant === 'no' && !summary.selection?.overLimit && (
          <Pill style={{ backgroundColor: 'rgba(245,158,11,0.14)', color: '#d97706' }}>本章不再埋新钩子</Pill>
        )}
        <div className="flex-1" />
        <span style={{ color: C.dim }}>一章最多收 2 个</span>
      </div>

      {open.length === 0 && (
        <div className="text-sm" style={{ color: C.dim }}>
          没有开着的钩子。写完一章会自动埋。
        </div>
      )}

      {open.map((h) => {
        const p = PRESSURE_STYLE[h.pressure?.level || 'cold'];
        return (
          <div key={h.id} className="rounded-lg px-3 py-2.5" style={{ backgroundColor: C.card }}>
            <div className="flex items-center gap-2">
              <Pill style={{ backgroundColor: p.bg, color: p.fg }}>{h.pressureLabel || p.label}</Pill>
              <span className="text-sm font-medium flex-1 min-w-0 truncate" style={{ color: C.text }}>
                {h.title}
              </span>
              <span className="text-[11px] whitespace-nowrap" style={{ color: C.dim }}>
                埋于第 {h.plantedIn} 章
              </span>
              <button
                className="text-[11px] px-2 py-0.5 rounded border"
                style={{ borderColor: C.line, color: C.sub }}
                onClick={() => act(h.id, 'close')}
                disabled={busy === h.id}
              >
                收了
              </button>
              <button
                className="text-[11px] px-2 py-0.5 rounded border"
                style={{ borderColor: C.line, color: C.dim }}
                onClick={() => act(h.id, 'drop')}
                disabled={busy === h.id}
              >
                不收了
              </button>
            </div>
            {h.detail && (
              <div className="text-xs mt-1.5" style={{ color: C.sub }}>
                {h.detail}
              </div>
            )}
          </div>
        );
      })}

      {closed.length > 0 && (
        <div>
          <div className="text-xs font-medium mb-2" style={{ color: C.sub }}>
            已了结（{closed.length}）
          </div>
          <div className="space-y-1">
            {closed.map((h) => (
              <div key={h.id} className="flex items-center gap-2 text-xs rounded-md px-2.5 py-1.5" style={{ backgroundColor: C.card }}>
                <Check size={12} style={{ color: '#16a34a' }} />
                <span style={{ color: C.sub }} className="flex-1 min-w-0 truncate">
                  {h.title}
                </span>
                <span style={{ color: C.dim }}>第 {h.closedIn} 章</span>
                <button
                  className="text-[11px] px-1.5 rounded"
                  style={{ color: C.dim }}
                  onClick={() => act(h.id, 'reopen')}
                  disabled={busy === h.id}
                  title="重新打开"
                >
                  <RotateCcw size={11} />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/* ============ 质检 tab ============ */

function QualityTab({ novel, summary }: { novel: ReturnType<typeof useNovel>; summary: NovelSummary }) {
  const [consistency, setConsistency] = useState<{ issues: ConsistencyIssue[]; fatalCount: number; warnCount: number; ok: boolean } | null>(null);
  const [lastLint, setLastLint] = useState<LintReport | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    novel
      .validateNow()
      .then((d) => alive && setConsistency(d))
      .catch(() => {})
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [novel, summary.currentChapter]);

  useEffect(() => {
    let alive = true;
    const last = summary.stats.chapters;
    if (!last) return;
    novel
      .chapter(last)
      .then((c) => alive && setLastLint(c.lint))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [novel, summary.stats.chapters]);

  if (loading) return <Loading loading text="跑一致性校验…" />;

  return (
    <div className="space-y-4">
      <div>
        <div className="text-xs font-medium mb-2 flex items-center gap-1.5" style={{ color: C.sub }}>
          <ShieldCheck size={13} /> 一致性（七类硬伤）
        </div>
        {consistency && consistency.issues.length === 0 ? (
          <div className="rounded-lg px-3 py-2.5 text-xs flex items-center gap-2" style={{ backgroundColor: 'rgba(22,163,74,0.10)', color: '#16a34a' }}>
            <Check size={13} /> 没有发现矛盾，设定自洽。
          </div>
        ) : (
          <div className="space-y-1.5">
            {consistency?.issues.map((i, idx) => {
              const s = SEVERITY_STYLE[i.severity] || SEVERITY_STYLE.info;
              return (
                <div key={idx} className="rounded-lg px-3 py-2 text-xs" style={{ backgroundColor: C.card }}>
                  <div className="flex items-center gap-2">
                    <Pill style={{ backgroundColor: s.bg, color: s.fg }}>{s.label}</Pill>
                    <span style={{ color: C.text }}>{i.text}</span>
                  </div>
                  {i.fix && (
                    <div className="mt-1" style={{ color: C.sub }}>
                      建议：{i.fix}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div>
        <div className="text-xs font-medium mb-2 flex items-center gap-1.5" style={{ color: C.sub }}>
          <ScanLine size={13} /> 上一章 AI 痕迹
        </div>
        {!lastLint ? (
          <div className="text-xs" style={{ color: C.dim }}>
            还没写过正文，写完一章这里会给体检结果。
          </div>
        ) : (
          <>
            <div className="flex items-center gap-3">
              <div
                className="w-12 h-12 rounded-xl flex items-center justify-center text-lg font-semibold"
                style={{ backgroundColor: LINT_STYLE[lastLint.level]?.bg, color: LINT_STYLE[lastLint.level]?.fg }}
              >
                {lastLint.score}
              </div>
              <div className="text-xs" style={{ color: C.sub }}>
                <div style={{ color: C.text }} className="font-medium">
                  {lastLint.label}
                </div>
                <div>{lastLint.hits.length} 处可疑 · 共 {lastLint.ruleCount} 条规则</div>
              </div>
            </div>
            <div className="mt-2 space-y-1">
              {lastLint.hits.slice(0, 8).map((h, i) => (
                <div key={i} className="rounded-md px-2.5 py-1.5 text-xs" style={{ backgroundColor: C.card }}>
                  <div className="flex items-center gap-1.5">
                    <span className="font-medium" style={{ color: C.text }}>
                      {h.label}
                    </span>
                    {h.severity === 'high' && (
                      <Pill style={{ backgroundColor: 'rgba(220,38,38,0.12)', color: '#dc2626' }}>重度</Pill>
                    )}
                    {h.line != null && (
                      <span style={{ color: C.dim }}>
                        第 {h.line} 行
                      </span>
                    )}
                  </div>
                  {h.text && (
                    <div className="mt-0.5" style={{ color: C.sub }}>
                      「{h.text}」
                    </div>
                  )}
                  {h.fix && (
                    <div className="mt-0.5" style={{ color: C.dim }}>
                      → {h.fix}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/* ============ 关系 tab ============ */

function GraphTab({ novel, summary }: { novel: ReturnType<typeof useNovel>; summary: NovelSummary }) {
  const [graph, setGraph] = useState<NovelGraph | null>(null);
  const [loading, setLoading] = useState(true);
  const [rebuilding, setRebuilding] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    novel
      .graph()
      .then((g) => alive && setGraph(g))
      .catch(() => {})
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [novel, summary.currentChapter, reloadKey]);

  const rebuild = useCallback(async () => {
    setRebuilding(true);
    try {
      const j = await novel.rebuildRelations();
      MessagePlugin.success(`重扫完成，得到 ${j.relations.length} 条关系`);
      setReloadKey((k) => k + 1);
    } catch (e: any) {
      MessagePlugin.error(e?.message || '重扫失败');
    } finally {
      setRebuilding(false);
    }
  }, [novel]);

  if (loading) return <Loading loading text="读取关系图…" />;
  if (!graph || !graph.nodes.length) return <div className="text-sm" style={{ color: C.dim }}>还没有人物。</div>;

  const noLinks = graph.links.length === 0;

  const W = 560;
  const H = 320;
  const cx = W / 2;
  const cy = H / 2;
  const R = Math.min(W, H) / 2 - 46;
  const pos = new Map<string, { x: number; y: number }>();
  graph.nodes.forEach((n, i) => {
    const a = (i / graph.nodes.length) * Math.PI * 2 - Math.PI / 2;
    pos.set(n.id, { x: cx + Math.cos(a) * R, y: cy + Math.sin(a) * R });
  });

  const kindColor: Record<string, string> = {
    ally: '#16a34a',
    enemy: '#dc2626',
    master: '#7c3aed',
    debt: '#d97706',
    unknows: '#94a3b8',
    broken: '#64748b',
    dead: '#64748b',
  };

  return (
    <div className="space-y-3">
      {noLinks && (
        <div
          className="rounded-lg px-3 py-2.5 text-xs"
          style={{ backgroundColor: 'rgba(245,158,11,0.10)', color: '#b45309' }}
        >
          <div className="flex items-center gap-1.5 font-medium">
            <AlertTriangle size={12} /> 这 {graph.nodes.length} 个人物之间还没有关系线
          </div>
          <div className="mt-1" style={{ color: C.sub }}>
            关系线来自两处：① 建书时从设定里读到的初始关系；② 每章写完回收时，
            从「两个人物正面照面」的戏里抽出来的变化。前几章如果人物还没真正碰面，这里就是空的——
            等写到有对手戏的章节，线会自己长出来。
          </div>
        </div>
      )}

      <div className="flex items-center gap-2">
        <span className="text-[11px]" style={{ color: C.dim }}>
          {graph.nodes.length} 个人物 · {graph.links.length} 条关系
        </span>
        <div className="flex-1" />
        <button
          className="text-[11px] inline-flex items-center gap-1 px-2 py-1 rounded-lg border"
          style={{ borderColor: C.line, color: C.sub }}
          onClick={rebuild}
          disabled={rebuilding}
          title="从设定和已写的正文里重新抽一遍人物关系"
        >
          {rebuilding ? <Loader2 size={11} className="animate-spin" /> : <RefreshCw size={11} />}
          {rebuilding ? '正在重扫…' : '从已写章节重扫关系'}
        </button>
      </div>

      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ maxHeight: 340 }}>
        {graph.links.map((l, i) => {
          const a = pos.get(l.source);
          const b = pos.get(l.target);
          if (!a || !b) return null;
          const color = kindColor[l.kind] || '#94a3b8';
          return (
            <g key={i} opacity={l.active ? 1 : 0.32}>
              <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={color} strokeWidth={1.4} strokeDasharray={l.active ? undefined : '4 3'} />
              <text
                x={(a.x + b.x) / 2}
                y={(a.y + b.y) / 2 - 3}
                fontSize={9}
                fill={color}
                textAnchor="middle"
              >
                {l.label}
              </text>
            </g>
          );
        })}
        {graph.nodes.map((n) => {
          const p = pos.get(n.id)!;
          return (
            <g key={n.id}>
              <circle cx={p.x} cy={p.y} r={19} fill={n.alive ? C.brand : '#94a3b8'} opacity={n.alive ? 1 : 0.55} />
              <text x={p.x} y={p.y + 3.5} fontSize={10} fill="#fff" textAnchor="middle">
                {n.name.slice(0, 2)}
              </text>
              <text x={p.x} y={p.y + 32} fontSize={10} fill={C.sub} textAnchor="middle">
                {n.name}
              </text>
            </g>
          );
        })}
      </svg>

      <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px]" style={{ color: C.sub }}>
        {Object.entries(kindColor)
          .filter(([k]) => graph.links.some((l) => l.kind === k))
          .map(([k, v]) => (
            <span key={k} className="inline-flex items-center gap-1">
              <span className="w-2.5 h-0.5 rounded" style={{ backgroundColor: v }} />
              {summary.relLabels?.[k] || k}
            </span>
          ))}
      </div>

      <div className="space-y-1">
        {graph.links.map((l, i) => (
          <div key={i} className="text-xs rounded-md px-2.5 py-1.5" style={{ backgroundColor: C.card, opacity: l.active ? 1 : 0.6 }}>
            <span style={{ color: C.text }} className="font-medium">
              {l.source} → {l.target}
            </span>
            <span style={{ color: kindColor[l.kind] || C.sub }}>　{l.label}</span>
            {!l.active && <span style={{ color: C.dim }}>（第 {l.until} 章结束）</span>}
            {l.note && (
              <div style={{ color: C.sub }} className="mt-0.5">
                {l.note}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

/* ============ 日志 tab ============ */

function LogTab({ novel, summary }: { novel: ReturnType<typeof useNovel>; summary: NovelSummary }) {
  const [log, setLog] = useState<NovelLogEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    novel
      .log()
      .then((d) => alive && setLog(d.log))
      .catch(() => {})
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [novel, summary.currentChapter]);

  if (loading) return <Loading loading text="读取日志…" />;
  if (!log.length) return <div className="text-sm" style={{ color: C.dim }}>还没有记录。</div>;

  return (
    <div className="space-y-1.5">
      {log.map((e, i) => (
        <div key={i} className="rounded-lg px-3 py-2 text-xs" style={{ backgroundColor: C.card }}>
          <div className="flex items-center gap-2">
            <ScrollText size={12} style={{ color: C.brand }} />
            <span className="font-medium" style={{ color: C.text }}>
              {e.action}
            </span>
            <div className="flex-1" />
            <span style={{ color: C.dim }}>{new Date(e.ts).toLocaleString('zh-CN', { hour12: false })}</span>
          </div>
          <div className="mt-1" style={{ color: C.sub }}>
            {e.detail}
          </div>
        </div>
      ))}
    </div>
  );
}

/* ============ 主组件 ============ */

interface NovelWorkbenchProps {
  novel: ReturnType<typeof useNovel>;
  onWriteNext: () => void;
  isWriting: boolean;
  agents: Array<{ id: string; name: string; description?: string }>;
  selectedAgentId: string;
  onSelectAgent: (id: string) => void;
  cwd: string;
  onSetCwd: (v: string) => void;
}

export function NovelWorkbench({
  novel,
  onWriteNext,
  isWriting,
  agents,
  selectedAgentId,
  onSelectAgent,
  cwd,
  onSetCwd,
}: NovelWorkbenchProps) {
  const [tab, setTab] = useState('memory');
  const [advanced, setAdvanced] = useState(false);
  const summary = novel.summary;

  if (novel.loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loading loading text="读取小说工程…" />
      </div>
    );
  }

  if (!novel.hasProject || !summary) {
    return (
      <div className="flex flex-col items-center justify-center h-full overflow-y-auto py-8">
        <BuildForm novel={novel} />
        {novel.error && (
          <div className="mt-4 text-xs" style={{ color: '#dc2626' }}>
            {novel.error}
          </div>
        )}
      </div>
    );
  }

  const nextNum = summary.currentChapter;
  const outlineItem = null as any;
  const total = summary.outlineTotal || 0;

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-3xl mx-auto py-6">
        {/* 项目头 */}
        <div className="rounded-2xl p-5" style={{ backgroundColor: C.card }}>
          <div className="flex items-start gap-3">
            <div
              className="w-11 h-11 rounded-xl flex items-center justify-center flex-shrink-0"
              style={{ background: 'linear-gradient(135deg, #7c3aed, #a855f7)' }}
            >
              <Feather size={20} color="white" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <h2 className="text-lg font-semibold truncate" style={{ color: C.text }}>
                  《{summary.title}》
                </h2>
                <Pill style={{ backgroundColor: C.brandLight, color: C.brand }}>
                  第 {nextNum} 章{total ? ` / 共 ${total} 章` : ''}
                </Pill>
              </div>
              <p className="text-xs mt-1 line-clamp-2" style={{ color: C.sub }}>
                {summary.seed}
              </p>
            </div>
          </div>

          {/* 状态条 */}
          <div className="grid grid-cols-4 gap-2 mt-4">
            {[
              { k: '已写', v: `${summary.stats.chapters} 章` },
              { k: '字数', v: `${summary.stats.words}` },
              { k: '坑（开着）', v: `${summary.health?.openHooks ?? 0}` },
              { k: '拖太久', v: `${summary.health?.overdueHooks ?? 0}`, warn: (summary.health?.overdueHooks ?? 0) > 0 },
            ].map((s) => (
              <div key={s.k} className="rounded-lg px-3 py-2" style={{ backgroundColor: C.container }}>
                <div className="text-[11px]" style={{ color: C.dim }}>
                  {s.k}
                </div>
                <div className="text-sm font-semibold" style={{ color: s.warn ? '#ea580c' : C.text }}>
                  {s.v}
                </div>
              </div>
            ))}
          </div>

          <div className="flex items-center gap-3 mt-4">
            <Button theme="primary" size="large" onClick={onWriteNext} loading={isWriting} disabled={isWriting}>
              <span className="inline-flex items-center gap-2">
                <Sparkles size={15} /> {isWriting ? '正在写…' : `续写第 ${nextNum} 章`}
              </span>
            </Button>
            <div className="text-[11px]" style={{ color: C.dim }}>
              会先注入记忆卡（设定 / 状态 / 钩子 / 上一章结尾），写完自动回收并体检。
            </div>
          </div>
        </div>

        {/* 面板 */}
        <div className="mt-5">
          <Tabs value={tab} onChange={(v) => setTab(v as string)}>
            <Tabs.TabPanel value="bible" label={<span className="inline-flex items-center gap-1.5"><ListOrdered size={13} />设定</span>}>
              <BibleTab novel={novel} summary={summary} />
            </Tabs.TabPanel>
            <Tabs.TabPanel value="memory" label={<span className="inline-flex items-center gap-1.5"><BookOpen size={13} />记忆</span>}>
              <MemoryTab novel={novel} summary={summary} />
            </Tabs.TabPanel>
            <Tabs.TabPanel
              value="hooks"
              label={
                <span className="inline-flex items-center gap-1.5">
                  <Anchor size={13} />钩子
                  {summary.health?.overdueHooks ? (
                    <span className="text-[10px] px-1 rounded" style={{ backgroundColor: 'rgba(234,88,12,0.16)', color: '#ea580c' }}>
                      {summary.health.overdueHooks}
                    </span>
                  ) : null}
                </span>
              }
            >
              <HooksTab novel={novel} summary={summary} />
            </Tabs.TabPanel>
            <Tabs.TabPanel value="quality" label={<span className="inline-flex items-center gap-1.5"><ShieldCheck size={13} />质检</span>}>
              <QualityTab novel={novel} summary={summary} />
            </Tabs.TabPanel>
            <Tabs.TabPanel value="graph" label={<span className="inline-flex items-center gap-1.5"><GitFork size={13} />关系</span>}>
              <GraphTab novel={novel} summary={summary} />
            </Tabs.TabPanel>
            <Tabs.TabPanel value="log" label={<span className="inline-flex items-center gap-1.5"><ScrollText size={13} />日志</span>}>
              <LogTab novel={novel} summary={summary} />
            </Tabs.TabPanel>
          </Tabs>
        </div>

        {/* 高级：Agent / 工作目录 / 导出 */}
        <div className="mt-5">
          <button
            className="text-xs inline-flex items-center gap-1"
            style={{ color: C.dim }}
            onClick={() => setAdvanced((v) => !v)}
          >
            <ChevronDown size={13} style={{ transform: advanced ? 'rotate(180deg)' : undefined, transition: '0.2s' }} />
            高级设置
          </button>

          {advanced && (
            <div className="mt-3 rounded-xl p-4 space-y-4" style={{ backgroundColor: C.card }}>
              {novel.projects.length > 1 && (
                <div>
                  <div className="text-xs font-medium mb-1.5" style={{ color: C.text }}>
                    切换作品（共 {novel.projects.length} 本）
                  </div>
                  <Select
                    value={summary.id}
                    onChange={(v) => novel.selectProject(v as string)}
                    options={novel.projects.map((p) => ({
                      label: `《${p.title}》${p.chapters ? ` · ${p.chapters} 章` : ' · 还没写'}`,
                      value: p.id,
                    }))}
                    style={{ width: '100%' }}
                  />
                </div>
              )}

              <div>
                <div className="text-xs font-medium mb-1.5" style={{ color: C.text }}>
                  Agent 人设
                </div>
                <Select
                  value={selectedAgentId}
                  onChange={(v) => onSelectAgent(v as string)}
                  options={agents.map((a) => ({ label: a.name, value: a.id }))}
                  style={{ width: '100%' }}
                />
              </div>

              <div>
                <div className="text-xs font-medium mb-1.5" style={{ color: C.text }}>
                  小说工程目录（可选）
                </div>
                <Input
                  value={cwd}
                  onChange={(v) => onSetCwd(v as string)}
                  placeholder="例如：D:\\novels\\我的小说"
                  prefixIcon={<FolderOpen size={14} />}
                />
                <div className="text-[11px] mt-1" style={{ color: C.dim }}>
                  指定后，Agent 可以读写这个目录里的设定文件与导出稿。
                </div>
              </div>

              <div>
                <div className="text-xs font-medium mb-1.5" style={{ color: C.text }}>
                  导出
                </div>
                <div className="flex gap-2">
                  {[
                    { kind: 'outline', label: '大纲', icon: ListOrdered },
                    { kind: 'full', label: '全文', icon: Download },
                    { kind: 'bible', label: '设定档案', icon: FileTextIcon },
                    { kind: 'report', label: '质量报告', icon: ShieldCheck },
                  ].map((x) => (
                    <a
                      key={x.kind}
                      href={`/api/novel/export?kind=${x.kind}`}
                      className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg border"
                      style={{ borderColor: C.line, color: C.sub }}
                    >
                      <x.icon size={12} /> {x.label}
                    </a>
                  ))}
                </div>
              </div>

              <div className="pt-1 border-t" style={{ borderColor: C.line }}>
                <button
                  className="mt-3 text-xs inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border"
                  style={{ borderColor: 'rgba(220,38,38,0.35)', color: '#dc2626' }}
                  onClick={async () => {
                    if (!window.confirm(`删掉《${summary.title}》？设定、记忆、已写的章都会一起删掉，不可恢复。`)) return;
                    try {
                      await novel.deleteProject(summary.id);
                      MessagePlugin.success('已删除');
                    } catch (e: any) {
                      MessagePlugin.error(e?.message || '删除失败');
                    }
                  }}
                >
                  <Trash2 size={12} /> 删掉这本，重新开始
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function FileTextIcon({ size }: { size: number }) {
  return <ScrollText size={size} />;
}
