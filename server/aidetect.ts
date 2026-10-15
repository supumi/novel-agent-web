/**
 * AI 痕迹检测（面向朱雀这类统计型检测器）
 * ======================================
 *
 * 上游 `engine/lint.mjs` 只有 10 条**用词型**规则（格言化收尾、抽象比喻、情绪直陈……），
 * 这些能改善文笔，但**不足以过朱雀** —— 朱雀这类检测器主要看的是**统计特征**，
 * 而不是你有没有用某个词：
 *
 *   1. 句长方差（burstiness）。人写网文忽长忽短，AI 的句子长度高度集中。
 *   2. 短句占比。真人大量使用 1–8 字的短句打节奏，AI 很少。
 *   3. 段落长度分布。AI 的段落长度异常均匀。
 *   4. 虚词密度。「的/了/是」的密度是稳定的统计指纹。
 *   5. 高频模板词与套话（仿佛/似乎/一丝/悄然 + 四字成语堆砌）。
 *   6. 连接词宣告转折（首先/然而/因此/与此同时）—— 真人写小说几乎不用。
 *
 * 所以这一层在 lint 之外补两块：
 *   · **rhythm**：文档级统计指标（这是过检测的主力）
 *   · **lexical**：把上游 lint 的分数与新增的套话规则合并
 * 最终分 = 0.6 × rhythm + 0.4 × lexical，rhythm 权重更高。
 *
 * 另外导出两个东西给别的模块用：
 *   · `ANTI_AI_GUIDE` —— 正向写作规则，注入到草稿提示词里（预防）
 *   · `rewriteBrief()` —— 针对具体命中段落的定点重写指令（治疗）
 */

// @ts-ignore 纯 JS 引擎，无类型声明
import * as lintMod from './engine/lint.mjs';

const lintEngine = lintMod as any;

export type Severity = 'high' | 'mid' | 'low';
export type Grade = 'obvious' | 'suspect' | 'mild' | 'clean';

export interface DetectHit {
  ruleId: string;
  label: string;
  desc: string;
  severity: Severity;
  suggest: string;
  excerpt: string;
  line: number | null;
  col: number | null;
  /** 段落序号（从 0 开始），定点重写时按这个分组 */
  para: number;
  source: 'lexical' | 'rhythm';
}

export interface DetectMetrics {
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
}

export interface DetectReport {
  score: number;
  grade: Grade;
  level: Grade;
  label: string;
  hits: DetectHit[];
  /** 0–100，统计节奏维度（过检测主力） */
  rhythm: number;
  /** 0–100，用词维度 */
  lexical: number;
  metrics: DetectMetrics;
  stats: DetectMetrics;
  ruleCount: number;
}

/* ============ 基础工具 ============ */

const CJK_RE = /[\u4e00-\u9fa5]/;
const SENT_END = /[。！？…]+/;

function splitParagraphs(text: string): string[] {
  return text.split(/\n+/);
}

function splitSentences(para: string): string[] {
  const out: string[] = [];
  let buf = '';
  for (const ch of para) {
    buf += ch;
    if (SENT_END.test(ch)) {
      if (buf.trim()) out.push(buf.trim());
      buf = '';
    }
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

const visibleLen = (s: string) => s.replace(/[\s，。！？、；：""''「」『』（）()—…·.,!?;:"'\-]/g, '').length;

function cv(nums: number[]): number {
  if (nums.length < 2) return 1;
  const mean = nums.reduce((a, b) => a + b, 0) / nums.length;
  if (mean <= 0) return 1;
  const variance = nums.reduce((a, b) => a + (b - mean) ** 2, 0) / nums.length;
  return Math.sqrt(variance) / mean;
}

const clamp = (n: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, n));
/** 把一个值从 [good, bad] 线性映射到 0–100 的「问题严重度」 */
function severityOf(value: number, good: number, bad: number): number {
  if (good === bad) return 0;
  const t = (value - good) / (bad - good);
  return clamp(t * 100);
}

/* ============ 套话词表 ============ */

/** AI 高频模糊副词/量词 —— 单个不算问题，密度高就是指纹 */
const HEDGE_WORDS = [
  '仿佛', '似乎', '宛如', '犹如', '宛若', '仿若', '好似',
  '一丝', '一抹', '一缕', '一股', '一阵', '些许',
  '悄然', '兀自', '终究', '不禁', '微微', '缓缓',
];

/** 书面四字成语堆砌 —— 网文正文里出现三个以上就很不自然 */
const IDIOMS = [
  '不由自主', '情不自禁', '若有所失', '怅然若失', '五味杂陈', '百感交集',
  '悄无声息', '不动声色', '若有所思', '心照不宣', '不置可否', '意味深长',
  '欲言又止', '如释重负', '心有余悸', '不寒而栗', '油然而生', '豁然开朗',
  '百无聊赖', '无所适从', '错综复杂', '不言而喻', '淋漓尽致', '与生俱来',
];

/** 连接词宣告 —— 小说里出现就是机器味 */
const CONNECTIVES = [
  '首先', '其次', '再者', '然而', '因此', '所以', '总之', '总而言之',
  '与此同时', '不仅如此', '换句话说', '值得一提的是', '值得注意的是',
  '综上所述', '毫无疑问', '不可否认', '显而易见', '正因如此', '正因如此',
];

/** 对举/递进模板句 */
const PARALLEL_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /不是[^。！？]{1,20}而是[^。！？]{1,20}/g, label: '「不是…而是…」对举' },
  { re: /与其[^。！？]{1,20}不如[^。！？]{1,20}/g, label: '「与其…不如…」对举' },
  { re: /不仅[^。！？]{1,20}(而且|还|也)[^。！？]{1,20}/g, label: '「不仅…而且…」递进' },
  { re: /既是[^。！？]{1,20}也是[^。！？]{1,20}/g, label: '「既是…也是…」并列' },
  { re: /无论[^。！？]{1,20}(都|也)[^。！？]{1,20}/g, label: '「无论…都…」无条件句' },
  { re: /只有[^。！？]{1,20}才[^。！？]{1,20}/g, label: '「只有…才…」条件句' },
];

/** 升华式结尾（最后一两段出现就非常可疑） */
const ELEVATION_PATTERNS = [
  /那一刻[，,]/,
  /从今往后/,
  /而这[，,]?(一切|才)/,
  /(才)?刚刚开始/,
  /他终于(明白|懂)了/,
  /她终于(明白|懂)了/,
  /有些(东西|事)[，,]?一旦/,
  /再也回不去/,
  /这就是(命运|人生|结局)/,
];

/** 破折号解释用法 */
const DASH_EXPLAIN = /——[^。！？\n]{4,30}/g;

/* ============ 文档级统计 ============ */

function computeMetrics(text: string, paragraphs: string[]) {
  const nonEmpty = paragraphs.filter((p) => p.trim());
  const allSentences: string[] = [];
  for (const p of nonEmpty) allSentences.push(...splitSentences(p));

  const sentLens = allSentences.map(visibleLen).filter((n) => n > 0);
  const paraLens = nonEmpty.map(visibleLen).filter((n) => n > 0);
  const chars = text.replace(/\s/g, '').length;

  const deCount = (text.match(/的/g) || []).length;
  const short = sentLens.filter((n) => n <= 8).length;
  const long = sentLens.filter((n) => n >= 40).length;

  return {
    chars,
    sentences: sentLens.length,
    paragraphs: nonEmpty.length,
    avgSentenceLen: sentLens.length ? +(sentLens.reduce((a, b) => a + b, 0) / sentLens.length).toFixed(1) : 0,
    sentenceCv: +cv(sentLens).toFixed(3),
    shortRatio: sentLens.length ? +(short / sentLens.length).toFixed(3) : 0,
    longRatio: sentLens.length ? +(long / sentLens.length).toFixed(3) : 0,
    paraCv: +cv(paraLens).toFixed(3),
    deRatio: chars ? +((deCount / chars) * 100).toFixed(2) : 0,
  };
}

/* ============ 主检测 ============ */

const GRADE_LABEL: Record<Grade, string> = {
  obvious: 'AI 味明显',
  suspect: '疑似 AI',
  mild: '轻微痕迹',
  clean: '自然',
};

export function gradeOf(score: number): Grade {
  if (score >= 70) return 'obvious';
  if (score >= 40) return 'suspect';
  if (score >= 15) return 'mild';
  return 'clean';
}

/**
 * 该不该送去降味。
 *
 * 不能只看总分：总分 = 节奏 × 0.6 + 用词 × 0.4，
 * 短文本（或者整篇节奏尚可、但套话满天飞的那种）会被节奏维度稀释，
 * 总分刚好卡在阈值下面 —— 于是「仿佛/一丝/悄然」原样留着，用户以为降味没生效。
 * 所以再加两条：用词分超标且有可定位的段落、或者段落级问题成堆，都算该改。
 *
 * 但也不能滥改：降味一轮要两次模型调用（改写 + 复检），
 * 实测把一篇 **6 分**（已经是「自然」档）的稿子改到 5 分，
 * 白花 80 多秒、还多一次把好文字改坏的机会。
 * 所以低分档直接放行 —— 够自然就别折腾。
 */
export function needsDeAI(
  r: { score: number; lexical: number; hits: Array<{ para: number }> },
  threshold = 32,
): boolean {
  // 已经是「自然」档，且用词也不脏 —— 不动它
  if (r.score <= 10 && r.lexical < 30) return false;

  if (r.score > threshold) return true;
  const targeted = r.hits.filter((h) => h.para >= 0);
  if (r.lexical >= 30 && targeted.length > 0) return true;
  // 段落级问题要成规模才值得改；零散两三处属于正常写作噪声
  return targeted.length >= 5 && r.score >= 12;
}

export function detect(text: string): DetectReport {
  const empty: DetectReport = {
    score: 0, grade: 'clean', level: 'clean', label: GRADE_LABEL.clean,
    hits: [], rhythm: 0, lexical: 0,
    metrics: {
      chars: 0, sentences: 0, paragraphs: 0, avgSentenceLen: 0,
      sentenceCv: 1, shortRatio: 0, longRatio: 0, paraCv: 1, deRatio: 0, hitCount: 0,
    },
    stats: null as any,
    ruleCount: 0,
  };
  if (!text || !text.trim()) return empty;

  const paragraphs = splitParagraphs(text);
  const metrics = computeMetrics(text, paragraphs);
  const hits: DetectHit[] = [];

  /* —— 1. 统计维度（rhythm）—— */
  const rhythmParts: Array<{ weight: number; value: number; hint: string }> = [];

  // 句长方差：人 0.55+，AI 常见 0.3–0.45
  const cvScore = severityOf(metrics.sentenceCv, 0.62, 0.3);
  rhythmParts.push({ weight: 30, value: cvScore, hint: '句子长短过于整齐' });
  if (cvScore >= 45) {
    hits.push({
      ruleId: 'rhythm-flat',
      label: '句长节奏单一',
      desc: `全篇句长变异系数只有 ${metrics.sentenceCv}（人写的网文通常 ≥0.6）。检测器主要看这个：句子长度越集中，越像机器。`,
      severity: cvScore >= 75 ? 'high' : 'mid',
      suggest: '故意把某些句子砍到 2–5 字，某些句子拉长到 40 字以上，制造长短落差。',
      excerpt: `平均句长 ${metrics.avgSentenceLen} 字 · 变异系数 ${metrics.sentenceCv}`,
      line: null, col: null, para: -1, source: 'rhythm',
    });
  }

  // 短句占比：人 15%+，AI <8%
  const shortScore = severityOf(metrics.shortRatio, 0.16, 0.03);
  rhythmParts.push({ weight: 25, value: shortScore, hint: '几乎没有短句' });
  if (shortScore >= 45) {
    hits.push({
      ruleId: 'rhythm-no-short',
      label: '缺少短句',
      desc: `8 字以内的短句只占 ${(metrics.shortRatio * 100).toFixed(1)}%（人写的正文通常 15% 以上）。短句是节奏感的主要来源。`,
      severity: shortScore >= 75 ? 'high' : 'mid',
      suggest: '插入「他没动。」「外面在下雨。」「不是现在。」这类独立短句打断节奏。',
      excerpt: `${metrics.sentences} 句里只有 ${Math.round(metrics.shortRatio * metrics.sentences)} 句是短句`,
      line: null, col: null, para: -1, source: 'rhythm',
    });
  }

  // 段落长度均匀度
  const paraScore = severityOf(metrics.paraCv, 0.55, 0.25);
  rhythmParts.push({ weight: 15, value: paraScore, hint: '段落长度太均匀' });
  if (paraScore >= 50) {
    hits.push({
      ruleId: 'rhythm-para-even',
      label: '段落长度均匀',
      desc: `段落长度变异系数 ${metrics.paraCv}，各段字数太接近。真人会随手写一个字的段落，也会写一大段。`,
      severity: 'mid',
      suggest: '让某一段只有一句话（甚至一个词），下一段写长一点。',
      excerpt: `${metrics.paragraphs} 个段落，长度分布过于集中`,
      line: null, col: null, para: -1, source: 'rhythm',
    });
  }

  // 平均句长偏长
  const longScore = severityOf(metrics.avgSentenceLen, 20, 38);
  rhythmParts.push({ weight: 15, value: longScore, hint: '平均句长偏长' });
  if (longScore >= 50) {
    hits.push({
      ruleId: 'rhythm-long',
      label: '平均句长偏长',
      desc: `平均每句 ${metrics.avgSentenceLen} 字。中文叙事句通常 15–25 字，偏长会显得平铺直叙。`,
      severity: 'mid',
      suggest: '把长句拆开，或用短句承接。',
      excerpt: `平均句长 ${metrics.avgSentenceLen} 字`,
      line: null, col: null, para: -1, source: 'rhythm',
    });
  }

  // 「的」密度
  const deScore = severityOf(metrics.deRatio, 4.0, 7.0);
  rhythmParts.push({ weight: 15, value: deScore, hint: '「的」字密度偏高' });
  if (deScore >= 50) {
    hits.push({
      ruleId: 'rhythm-de',
      label: '「的」字密度偏高',
      desc: `「的」占 ${metrics.deRatio}%。这是最稳定的统计指纹之一，密度越高越像生成文本。`,
      severity: 'mid',
      suggest: '删掉定语里的「的」：「他的手里」→「他手里」。',
      excerpt: `「的」字密度 ${metrics.deRatio}%`,
      line: null, col: null, para: -1, source: 'rhythm',
    });
  }

  const rhythmTotal = rhythmParts.reduce((a, p) => a + p.weight, 0);
  const rhythm = Math.round(
    clamp(rhythmParts.reduce((a, p) => a + p.weight * p.value, 0) / (rhythmTotal || 1)),
  );

  /* —— 2. 套话维度（lexical 新增部分）—— */
  let extraLexical = 0;

  // 连接词
  const connectiveHits: string[] = [];
  paragraphs.forEach((para, pi) => {
    for (const w of CONNECTIVES) {
      let idx = para.indexOf(w);
      while (idx >= 0) {
        connectiveHits.push(w);
        hits.push({
          ruleId: 'connective',
          label: '连接词宣告',
          desc: `「${w}」是说明文连接词。小说里靠句序和动作推进，不靠连接词。`,
          severity: 'mid',
          suggest: `删掉「${w}」，让上下句直接相接。`,
          excerpt: para.slice(Math.max(0, idx - 12), idx + 14),
          line: null, col: idx, para: pi, source: 'lexical',
        });
        idx = para.indexOf(w, idx + w.length);
      }
    }
  });
  extraLexical += Math.min(30, connectiveHits.length * 6);

  // 对举模板
  paragraphs.forEach((para, pi) => {
    for (const { re, label } of PARALLEL_PATTERNS) {
      re.lastIndex = 0;
      for (const m of para.matchAll(re)) {
        hits.push({
          ruleId: 'parallel-template',
          label,
          desc: '对称句式是模型组织语言时的默认结构，真人很少写得这么整齐。',
          severity: 'mid',
          suggest: '把其中一个分句删掉，或改成一个具体动作。',
          excerpt: m[0].slice(0, 40),
          line: null, col: m.index ?? null, para: pi, source: 'lexical',
        });
        extraLexical += 5;
      }
    }
  });

  // 模糊副词密度
  const hedgeCount: Record<string, number> = {};
  for (const w of HEDGE_WORDS) {
    const n = (text.match(new RegExp(w, 'g')) || []).length;
    if (n > 0) hedgeCount[w] = n;
  }
  const hedgeTotal = Object.values(hedgeCount).reduce((a, b) => a + b, 0);
  const hedgePer1000 = metrics.chars ? (hedgeTotal / metrics.chars) * 1000 : 0;
  if (hedgePer1000 > 8) {
    const top = Object.entries(hedgeCount)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([w, n]) => `${w}×${n}`)
      .join('、');
    hits.push({
      ruleId: 'hedge-density',
      label: '模糊副词密度高',
      desc: `每千字 ${hedgePer1000.toFixed(1)} 个「仿佛/似乎/一丝/悄然」这类词。它们是模型的语感填充物。`,
      severity: hedgePer1000 > 16 ? 'high' : 'mid',
      suggest: '删掉一半以上。想表达不确定就直接写不确定，不要用「仿佛」。',
      excerpt: top,
      line: null, col: null, para: -1, source: 'lexical',
    });
    extraLexical += Math.min(25, Math.round((hedgePer1000 - 8) * 2.5));
  }

  // 四字成语堆砌
  const idiomFound = IDIOMS.filter((w) => text.includes(w));
  if (idiomFound.length >= 3) {
    hits.push({
      ruleId: 'idiom-pile',
      label: '四字成语堆砌',
      desc: `出现了 ${idiomFound.length} 个书面四字词。网文正文用成语越少越像人写的。`,
      severity: idiomFound.length >= 5 ? 'high' : 'mid',
      suggest: '换成具体动作。例如「不动声色」→「他继续擦杯子，没抬头」。',
      excerpt: idiomFound.join('、'),
      line: null, col: null, para: -1, source: 'lexical',
    });
    extraLexical += Math.min(20, idiomFound.length * 4);
  }

  // 升华式结尾
  const tailStart = Math.max(0, paragraphs.length - 2);
  paragraphs.slice(tailStart).forEach((para, i) => {
    for (const re of ELEVATION_PATTERNS) {
      const m = para.match(re);
      if (m) {
        hits.push({
          ruleId: 'elevation-ending',
          label: '升华式结尾',
          desc: '结尾往主题上拔高，是 AI 收束文本的固定动作，也是检测器最容易抓的段落级特征。',
          severity: 'high',
          suggest: '砍掉最后这句升华。让章节停在一个具体动作或一句对白上。',
          excerpt: para.slice(Math.max(0, (m.index ?? 0) - 10), (m.index ?? 0) + 26),
          line: null, col: m.index ?? null, para: tailStart + i, source: 'lexical',
        });
        extraLexical += 10;
      }
    }
  });

  // 破折号解释
  const dashCount = (text.match(DASH_EXPLAIN) || []).length;
  if (dashCount >= 4) {
    hits.push({
      ruleId: 'dash-explain',
      label: '破折号解释过多',
      desc: `用了 ${dashCount} 次「——」补充说明。这是书面语习惯，叙事文里显得在解释而非呈现。`,
      severity: 'low',
      suggest: '删掉破折号，把补充内容变成独立短句，或直接不要。',
      excerpt: `共 ${dashCount} 处`,
      line: null, col: null, para: -1, source: 'lexical',
    });
    extraLexical += Math.min(12, dashCount * 2);
  }

  // 段首同构：多个段落用同样的起手式
  const openings: Record<string, number> = {};
  paragraphs.forEach((p) => {
    const head = p.trim().slice(0, 3).replace(/[^\u4e00-\u9fa5]/g, '');
    if (head.length === 3) openings[head] = (openings[head] || 0) + 1;
  });
  const repeated = Object.entries(openings).filter(([, n]) => n >= 3);
  if (repeated.length) {
    hits.push({
      ruleId: 'same-opening',
      label: '段落起手式重复',
      desc: `有 ${repeated.length} 组段落用同样的三个字开头（${repeated.map(([k, n]) => `${k}×${n}`).join('、')}）。`,
      severity: 'mid',
      suggest: '换掉重复的段首，或把其中一段并入上一段。',
      excerpt: repeated.map(([k]) => k).join('、'),
      line: null, col: null, para: -1, source: 'lexical',
    });
    extraLexical += Math.min(15, repeated.length * 6);
  }

  /* —— 3. 合并上游 lint（用词型规则）—— */
  let upstreamScore = 0;
  let upstreamHits: any[] = [];
  try {
    const r = lintEngine.lint(text);
    upstreamScore = typeof r?.score === 'number' ? r.score : 0;
    upstreamHits = Array.isArray(r?.hits) ? r.hits : [];
  } catch {
    /* 引擎异常不影响主流程 */
  }

  // 上游命中挂到段落上，方便定点重写
  const paraIndexOf = (excerpt: string) => {
    if (!excerpt) return -1;
    const key = excerpt.slice(0, 12);
    return paragraphs.findIndex((p) => key && p.includes(key));
  };
  for (const h of upstreamHits) {
    hits.push({
      ruleId: h.ruleId || '',
      label: h.label || h.ruleId || '',
      desc: h.desc || '',
      severity: (h.severity as Severity) || 'mid',
      suggest: h.suggest || '',
      excerpt: h.excerpt || '',
      line: h.line ?? null,
      col: h.col ?? null,
      para: paraIndexOf(h.excerpt || ''),
      source: 'lexical',
    });
  }

  const lexical = Math.round(clamp(upstreamScore * 0.55 + extraLexical));

  /* —— 4. 合并总分：统计维度权重更高 —— */
  const score = Math.round(clamp(rhythm * 0.6 + lexical * 0.4));
  const grade = gradeOf(score);

  // 命中排序：high → mid → low
  const order: Record<Severity, number> = { high: 0, mid: 1, low: 2 };
  hits.sort((a, b) => order[a.severity] - order[b.severity]);

  const metricsWithHits: DetectMetrics = { ...metrics, hitCount: hits.length };

  return {
    score,
    grade,
    level: grade,
    label: GRADE_LABEL[grade],
    hits,
    rhythm,
    lexical,
    metrics: metricsWithHits,
    stats: metricsWithHits,
    ruleCount: (lintEngine.RULE_LIST?.length || 0) + 11,
  };
}

/* ============ 给模型看的两份材料 ============ */

/**
 * 正向写作规则 —— 注入草稿提示词，从源头减少 AI 味。
 * 刻意用「要这样写」而不是「不要那样写」：给正例比下禁令有效得多。
 */
export const ANTI_AI_GUIDE = `【让文字不像机器写的 —— 六条硬指标】

1. 句子长短要打架。
   一段里必须同时有 2–6 字的短句和 30 字以上的长句。
   全是十几二十字的句子，就是机器节奏。
   例：「他没动。门外脚步声来回走了三趟，每趟都在门口停一下，像在数什么。」
   （注意：这里「像在数什么」是具体动作，不是抽象比喻。）

2. 段落长短要打架。
   允许出现只有一句话、甚至只有两个字的段落。
   例：「没了。」单独成段。

3. 少用「的」。
   定语里的「的」能删就删：「他的手里」→「他手里」，「湿漉漉的地面」→「地面湿着」。

4. 禁用这些词（一个都别用）：
   仿佛、似乎、宛如、犹如、宛若、一丝、一抹、一缕、些许、悄然、兀自、不禁
   首先、其次、然而、因此、总之、与此同时、不仅如此、换句话说、值得注意的是
   不由自主、情不自禁、怅然若失、五味杂陈、不动声色、意味深长、欲言又止

5. 禁用这些句式：
   「不是…而是…」「与其…不如…」「不仅…而且…」「既是…也是…」「无论…都…」
   「比他自己预想的」「他感到一阵」「心中涌起」「那一刻，他明白了」

6. 结尾不许升华。
   最后一段必须落在一个**具体的东西**上：一个动作、一件物件、一句没头没尾的对白。
   绝对不要写「而这，才只是开始」「从今往后」「有些事一旦…就再也…」这类总结。

判断标准很简单：写完读一遍，如果每一段读起来都「很顺、很完整、很得体」，
那就是机器写的。人写的东西是毛的、有疙瘩的、句子长短不齐的。`;

/**
 * 定点重写指令 —— 只改命中的段落，不重写全文。
 * 这样既省 token 又不会把好的部分改坏。
 */
export function rewriteBrief(report: DetectReport, text: string): string {
  const paragraphs = splitParagraphs(text);

  const order: Record<Severity, number> = { high: 0, mid: 1, low: 2 };
  const byPara = new Map<number, { severity: Severity; issues: Set<string> }>();

  const add = (pi: number, severity: Severity, issue: string) => {
    if (pi < 0 || pi >= paragraphs.length) return;
    let e = byPara.get(pi);
    if (!e) {
      e = { severity, issues: new Set() };
      byPara.set(pi, e);
    }
    if (order[severity] < order[e.severity]) e.severity = severity;
    e.issues.add(issue);
  };

  // 1) 命中型：检测器已经定位到段落的，直接收进来
  for (const h of report.hits) add(h.para, h.severity, h.label);

  // 2) 词表型：再直接扫一遍段落。
  //    光靠命中归因是不够的 —— 像「模糊副词密度」是整篇统计出来的，没有具体段落，
  //    结果就是：报告里写着「仿佛太多」，但没有任何一段被送去改写，「仿佛」原样留着。
  //    这里保证「含禁用词的段落」一定进改写名单。
  paragraphs.forEach((p, pi) => {
    const found: string[] = [];
    for (const w of HEDGE_WORDS) if (p.includes(w)) found.push(w);
    for (const w of IDIOMS) if (p.includes(w)) found.push(w);
    for (const w of CONNECTIVES) if (p.includes(w)) found.push(w);
    for (const { re } of PARALLEL_PATTERNS) {
      re.lastIndex = 0;
      if (re.test(p)) found.push('对称句式');
    }
    if (found.length) {
      add(pi, 'mid', `套话：${[...new Set(found)].slice(0, 4).join('、')}`);
    }
  });

  const targets = [...byPara.entries()]
    .sort((a, b) => order[a[1].severity] - order[b[1].severity] || a[0] - b[0])
    .slice(0, 12);

  const lines: string[] = [];
  for (const [pi, e] of targets) {
    lines.push(`【第 ${pi + 1} 段】（问题：${[...e.issues].join('、')}）\n原文：${paragraphs[pi].trim()}`);
  }

  const globalNotes: string[] = [];
  const m = report.metrics;
  if (m.sentenceCv < 0.55) globalNotes.push(`全篇句长太整齐（变异系数 ${m.sentenceCv}，目标 ≥0.6）：制造长短落差`);
  if (m.shortRatio < 0.14) globalNotes.push(`短句太少（占 ${(m.shortRatio * 100).toFixed(1)}%，目标 ≥15%）：多插 2–6 字的独立短句`);
  if (m.deRatio > 4.5) globalNotes.push(`「的」太多（${m.deRatio}%，目标 ≤4.2%）：删定语里的「的」`);
  if (m.paraCv < 0.5) globalNotes.push(`段落长度太均匀：让某段只剩一句话`);

  return `全篇节奏诊断（改的时候要一并解决）：
${globalNotes.length ? globalNotes.map((n) => '· ' + n).join('\n') : '· （无明显全局问题）'}

下面是需要定点改写的段落，共 ${targets.length} 段：

${lines.join('\n\n')}`;
}
