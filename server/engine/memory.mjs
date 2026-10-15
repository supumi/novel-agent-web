// 关系与阵营：让模型知道「谁跟谁一边的、谁欠谁的、谁死了」
import { validate, validatePrompt, SEVERITY } from './consistency.mjs';

//
// 解决的问题：生成下一章时，模型怎么知道前面发生了什么；
// 未回收的坑怎么不丢；以及这一切怎么存到自己电脑上。
//
// 分四层，性质不同：
//   canon  硬设定，不可自动改（世界规则、人物核心创伤）
//   state  现状，每章自动更新（人在哪、处境如何、谁死了）
//   hooks  钩子，埋下→到期→回收，带压力值
//   recent 近场，保留原文语感（最后两章全文，再往前只要摘要）

/** 钩子的生命周期 */
export const HOOK_STATE = {
  open: 'open',        // 已埋未收
  closed: 'closed',    // 已回收
  dropped: 'dropped',  // 已放弃
};

/** 关系类型的中文标签（给模型看，要用中文） */
export const REL_LABELS = {
  ally: '是盟友',
  enemy: '是敌人',
  master: '是上级',
  debt: '欠人情',
  unknows: '互不相识',
  broken: '已经决裂',
  dead: '已经死了',
};

/**
 * 压力值：越大越该收。
 * 设计理由——坑埋着不收，读者会忘；但一直不收也糟。
 * 到 4 就该强制提醒，超过 6 建议放弃或重埋。
 * 阈值按「埋下后经过的章数」算，不是绝对章数。
 */
export function hookPressure(hook, currentChapter) {
  if (hook.status !== HOOK_STATE.open) return null;
  const age = currentChapter - (hook.plantedIn || 1);
  if (age <= 0) return { age, level: 'cold', weight: 0 };
  if (age <= 2) return { age, level: 'warm', weight: 1 };
  if (age <= 4) return { age, level: 'due', weight: 2 };
  if (age <= 6) return { age, level: 'overdue', weight: 3 };
  return { age, level: 'rotten', weight: 4 };
}

/**
 * 选出本章应该处理的钩子。
 * 策略：优先收到期最久的，但一章最多收两个——贪多会毁掉节奏。
 *
 * 2026-10-05 加：MAX_OPEN_HOOKS。
 * 原来只管「单个钩子该多久收」，不管「总共有多少开着」——
 * 实测写到 200 章会攒 33 个开着的坑，模型分不清哪个优先，
 * 记忆卡也会被撑大。现在到量了就强制收，并警告超量。
 *
 * 2026-10-06 调低到 6：接了真模型后实测发现 3 章就埋了 11 个——
 * 真实模型看到「本章要埋新钩子」会**一次埋好几个**（一条龙：工号、戒痕、
 * 叫错名字、卷宗编号…）。所以阈值按真模型的实际行为定，不按直觉。
 */
export const MAX_OPEN_HOOKS = 6;

export function selectHooks(memory, currentChapter) {
  const allOpen = memory.hooks.filter(h => h.status === HOOK_STATE.open);
  const open = allOpen
    .map(h => ({ ...h, pressure: hookPressure(h, currentChapter) }))
    .filter(h => h.pressure.weight > 0)
    .sort((a, b) => b.pressure.weight - a.pressure.weight || a.plantedIn - b.plantedIn);

  const overLimit = allOpen.length > MAX_OPEN_HOOKS;
  // 超量时最多收 3 个（比平时多一个），不然追不上
  const quota = overLimit ? 3 : 2;

  return {
    // 本章该收的
    due: open.slice(0, quota),
    // 本章该不该埋新坑：坑太多时停手，先消化
    plant: (allOpen.length >= MAX_OPEN_HOOKS || allOpen.length > 5) ? 'no' : 'yes',
    // 到期但没被收的，要提醒
    overdue: allOpen
      .filter(h => ['overdue', 'rotten'].includes(hookPressure(h, currentChapter)?.level))
      .map(h => h.title),
    // 总量健康
    openTotal: allOpen.length,
    overLimit,
    maxOpen: MAX_OPEN_HOOKS,
  };
}

/**
 * 本章涉及哪些人物？
 * 优先取大纲里点名的；没点名就取全部（宁可多给也不漏）。
 */
function collectFocusNames(memory, chapterNum) {
  const names = new Set();
  const outlineItem = memory._outlineCache?.[chapterNum];
  if (outlineItem) {
    for (const n of (outlineItem.characters || [])) names.add(n);
  }
  // 大纲没存人物时退化为「全部角色」——关系数量受控，不会撑爆
  if (!names.size) {
    for (const c of memory.state.characters) names.add(c.name);
  }
  return [...names];
}

/**
 * 构造「本章记忆卡」：塞进 prompt，让模型知道该接什么、该收什么。
 * 这是「自动串起来」的核心——模型看不见前 30 章，但能看见这张卡。
 */
export function buildMemoryCard(memory, chapterNum) {
  const { due, plant, overdue } = selectHooks(memory, chapterNum);
  const recentCh = memory.chapters
    .filter(c => c.num < chapterNum)
    .sort((a, b) => b.num - a.num);

  // 硬设定：不能动的东西
  const canonLines = [];
  if (memory.canon.world?.length) {
    canonLines.push('世界规则：' + memory.canon.world.map(w => `${w.name}——${w.rule}`).join('；'));
  }
  for (const c of memory.canon.characters || []) {
    canonLines.push(`${c.name}：想要「${c.want}」，创伤是${c.wound}，口吻${c.voice}。${c.fixed ? '这一点不可改。' : ''}`);
  }

  // 现状：人在哪、处境如何
  // condition 也截断：模型每章都会把状态写得更详细（实测 48→74 字），
  // 不截断的话 200 章后这一段会有两三千字。
  const clipS = (s, n) => (s && s.length > n ? s.slice(0, n) + '…' : (s || ''));
  const stateLines = (memory.state.characters || [])
    .map(c => `${c.name}：${clipS(c.where, 10)}｜${clipS(c.condition, 50)}`);

  // 钩子
  // 截断理由：2026-10-06 实测，真模型给的钩子 detail 能写到 200+ 字
  // （「陈默在保险柜夹层发现一张康宁疗养院黑白照片，背面标签写着…」）。
  // 钩子一多，这些长描述会把记忆卡撑爆——但钩子本身只需要一句话说清是什么。
  const clip = (s, n) => (s && s.length > n ? s.slice(0, n) + '…' : (s || ''));
  const hookLines = [];
  if (due.length) {
    hookLines.push('本章要回收：' + due.map(h =>
      `「${h.title}」${h.detail ? `（${clip(h.detail, 40)}）` : ''}，埋在第${h.plantedIn}章，已经过了${h.pressure.age}章`
    ).join('；'));
  }
  if (plant === 'yes') {
    hookLines.push('本章要埋一个新钩子（具体的物件或动作，不要用抽象概括）。');
  } else if (overdue.length) {
    hookLines.push('本章不要再埋新钩子，先把开着的消化掉。');
  }
  if (overdue.length) {
    hookLines.push('注意：这些钩子已经拖太久，本章优先处理：' + overdue.join('、'));
  }
  if (due.length > 2) {
    hookLines.push(`本章要收 ${due.length} 个钩子（超量了），能收几个收几个。`);
  }

  // 关系网：只给「和本章相关人物有关的」，不铺开所有边，否则 prompt 爆炸。
  // 2026-10-05 修：原来这里引用了不存在的变量 u（u 是 applyStateUpdate 的参数），
  // 导致 buildMemoryCard 直接抛 ReferenceError。改成从大纲取本章涉及的人物。
  const relLines = [];
  const focus = new Set(collectFocusNames(memory, chapterNum));
  const related = memory.relations.filter(r => {
    if (r.until != null) return false;                 // 已结束的
    return focus.has(r.from) || focus.has(r.to);
  });
  if (related.length) {
    relLines.push('人物关系（和本章相关人物的）：');
    for (const r of related.slice(0, 6)) {
      const k = REL_LABELS[r.kind] || r.kind;
      relLines.push(`  ${r.from} ${k} ${r.to}${r.label ? `（${r.label}）` : ''}`);
    }
  }

  // 阵营
  const facLines = [];
  for (const c of memory.state.characters) {
    if (c.faction) facLines.push(`${c.name} 属于「${c.faction}」`);
  }
  const deadList = memory.state.characters.filter(c => c.alive === false).map(c => c.name);
  if (deadList.length) {
    facLines.push(`已死亡，不要再出场：${deadList.join('、')}`);
  }

  // 一致性校验：把「已经打自己的脸」的地方告诉模型，让它别再犯
  const guard = (() => {
    try {
      const v = validate(memory, chapterNum);
      return validatePrompt(v.issues);
    } catch { return ''; }   // 校验出问题不阻塞生成
  })();

  return {
    canon: canonLines,
    state: stateLines,
    hooks: hookLines,
    relations: relLines,
    factions: facLines,
    guard,
    // 上一章原文：保持语感连贯的关键（不是摘要，是原文）
    // 2026-10-05 修：原来读 c.content，但 memory.chapters 只存了摘要，
    // 导致这里永远是空串，衔接机制等于没生效。
    lastChapter: recentCh[0]?.tail || '',
    // 前几章的摘要：情节接续用
    recentSummary: recentCh.slice(1, 4).map(c => `第${c.num}章：${c.summary}`).filter(Boolean),
    due, overdue,
  };
}

/**
 * 抽取正文摘要：取前几句，够用且不花钱。
 * 不追求概括能力——只要能看出「发生了什么」。
 */
export function makeSummary(content) {
  if (!content) return '';
  const paras = content.split('\n\n').filter(p => p.trim());
  const head = paras.slice(0, 3).join(' ');
  return head.length > 120 ? head.slice(0, 120) + '…' : head;
}

/** 状态迁移：只允许常识性的更新，不允许改硬设定 */
export function applyStateUpdate(memory, updates, chapterNum) {
  const notes = [];
  for (const u of updates) {
    if (u.kind === 'character_update') {
      const c = memory.state.characters.find(x => x.name === u.target);
      if (!c) { notes.push(`跳过：找不到人物 ${u.target}`); continue; }
      const before = c.condition;
      // 2026-10-06 修：新状态在 u.after，不是 u.condition。
      // 原来只读 condition（永远是空），导致「沈砚：A → A」这种状态不变。
      const newState = u.after || u.condition || '';
      if (u.where) c.where = u.where;
      if (newState) c.condition = newState;
      if (u.alive !== undefined) c.alive = u.alive;
      c.lastSeenIn = chapterNum;
      notes.push(`${u.target}：${before} → ${c.condition}`);
    } else if (u.kind === 'death') {
      const c = memory.state.characters.find(x => x.name === u.target);
      if (c) {
        c.alive = false;
        c.diedIn = chapterNum;
        c.condition = u.detail || '已死亡';
        // 死人的所有活跃关系都结束
        for (const r of memory.relations) {
          if (r.until == null && (r.from === c.name || r.to === c.name)) {
            r.until = chapterNum;
            if (r.kind === 'ally') r.kind = 'dead';
          }
        }
        notes.push(`死亡：${c.name}（第 ${chapterNum} 章）`);
      } else {
        notes.push(`跳过：找不到人物 ${u.target}`);
      }
    } else if (u.kind === 'timeline') {
      memory.state.clock = u.detail || memory.state.clock;
      notes.push(`时间推进：${u.detail || u.target}`);
    } else if (u.kind === 'foreshadow_pay') {
      const h = findHook(memory, u.target);
      if (h) {
        h.status = HOOK_STATE.closed;
        h.closedIn = chapterNum;
        h.closedBy = u.detail || '';
        notes.push(`回收：「${h.title}」（埋在第${h.plantedIn}章，拖了${chapterNum - h.plantedIn}章）`);
      } else {
        notes.push(`跳过：找不到要回收的钩子「${u.target}」`);
      }
    } else if (u.kind === 'foreshadow_plant') {
      // 同一个物件不重复埋。
      // 2026-10-06 修：原来只比 title 完全相等，模型每次描述都不同
      // （「金属片上的第七层刻字」/「沈迟的金属片」/「空白金属片」），
      // 结果同一个物件被埋了 4 次。改用模糊匹配。
      const dup = findHook(memory, u.target, { includeClosed: true });
      if (dup) {
        notes.push(`跳过：「${u.target}」和已有的「${dup.title}」是同一个钩子`);
        continue;
      }
      memory.hooks.push({
        id: `h${Date.now().toString(36)}${memory.hooks.length}`,
        title: u.target,
        detail: u.detail || '',
        payPlan: u.payPlan || '',
        plantedIn: chapterNum,
        status: HOOK_STATE.open,
      });
      notes.push(`埋下：「${u.target}」`);
    } else if (u.kind === 'thread_open') {
      memory.state.threads.push({
        title: u.target, detail: u.detail || '', openedIn: chapterNum, status: 'open',
      });
      notes.push(`支线：${u.target}`);
    } else if (u.kind === 'relation_change') {
      // 关系是覆盖式的：同 from→to 再来一次就更新，不重复堆积
      const from = u.from || u.target;
      const to = u.to;
      if (!from || !to) {
        notes.push(`跳过：关系变更缺 from/to（${u.detail || ''}）`);
        continue;
      }
      const existing = memory.relations.find(r => r.from === from && r.to === to);
      const before = existing ? `${existing.kind}${existing.label ? '（' + existing.label + '）' : ''}` : '无';
      if (existing) {
        // 旧关系如果被反转（A→B 变 B→A），把旧边标为已结束
        const opposite = memory.relations.find(r => r.from === to && r.to === from);
        if (opposite && opposite.until == null) opposite.until = chapterNum;
        existing.kind = u.relationKind || u.kind2 || existing.kind;
        existing.label = u.detail || existing.label;
        existing.until = null;
        existing.since = existing.since || chapterNum;
        notes.push(`关系变更：${from}→${to}  ${before} → ${existing.kind}`);
      } else {
        memory.relations.push({
          from, to,
          kind: u.relationKind || 'ally',
          label: u.detail || '',
          since: chapterNum,
          until: null,
        });
        notes.push(`新关系：${from} → ${to}（${u.relationKind || 'ally'}）${u.detail ? ' ' + u.detail : ''}`);
      }
      // 关系断了，另一侧也标结束
      if (u.relationKind === 'broken' || u.relationKind === 'dead') {
        const r = memory.relations.find(x => x.from === from && x.to === to);
        if (r) { r.kind = u.relationKind; r.until = chapterNum; }
      }
    } else if (u.kind === 'faction_change') {
      const c = memory.state.characters.find(x => x.name === u.target);
      if (c) {
        const before = c.faction || '无阵营';
        c.faction = u.detail || c.faction;
        notes.push(`阵营变更：${u.target}  ${before} → ${c.faction}`);
      } else {
        notes.push(`跳过：找不到人物 ${u.target}`);
      }
    } else if (u.kind === 'death') {
      const c = memory.state.characters.find(x => x.name === u.target);
      if (c) {
        c.alive = false;
        c.condition = u.detail || '已死亡';
        notes.push(`死亡：${u.target}`);
      }
    } else if (u.kind === 'attribute') {
      const c = memory.state.characters.find(x => x.name === u.target);
      if (c) {
        const key = u.field || '状态';
        const before = c.attributes[key] ?? '未记录';
        c.attributes[key] = u.detail || u.after || '';
        notes.push(`${u.target} 的「${key}」：${before} → ${c.attributes[key]}`);
      }
    } else if (u.kind === 'clock') {
      const before = memory.state.clock;
      memory.state.clock = u.detail || u.target || before;
      notes.push(`时间：${before} → ${memory.state.clock}`);
    }
  }

  // 记录本章的时间线节点
  const evts = updates
    .filter(u => ['relation_change', 'faction_change', 'death', 'attribute', 'clock', 'foreshadow_pay', 'foreshadow_plant'].includes(u.kind))
    .map(u => ({ kind: u.kind, text: describeEvent(u), text2: '' }));
  if (evts.length || memory.state.clock) {
    memory.timeline.push({
      chapter: chapterNum,
      clock: memory.state.clock,
      events: evts,
    });
  }

  return notes;
}

function describeEvent(u) {
  switch (u.kind) {
    case 'relation_change': return `${u.from} → ${u.to}：${u.relationKind || 'ally'}${u.detail ? '（' + u.detail + '）' : ''}`;
    case 'faction_change': return `${u.target} 转投 ${u.detail}`;
    case 'death': return `${u.target} 死亡`;
    case 'attribute': return `${u.target} 的${u.field || '状态'}：${u.detail || u.after}`;
    case 'clock': return `时间：${u.detail || u.target}`;
    case 'foreshadow_pay': return `回收伏笔「${u.target}」`;
    case 'foreshadow_plant': return `埋下伏笔「${u.target}」`;
    default: return u.detail || u.target || '';
  }
}

/**
 * 模糊匹配钩子。
 *
 * 为什么需要：模型每次描述同一个物件都会换措辞。50 章实测里同一个「金属片」
 * 被埋成六个：
 *   金属片上的第七层刻字 / 沈迟的金属片 / 2001年前的空位金属片 / 空白金属片
 *   缺失的015与016金属片 / 周砚给林雾的金属片
 * 精确匹配完全抓不住——归一化后分别是「金属片刻字」「沈迟金属片」
 * 「前空位金属片」，既没有子串关系，也没共同前缀。
 *
 * 走过的弯路（2026-10-06）：
 *   1. 二元组重叠 → 共享 0 个组
 *   2. 3 字滑窗   → 切出「金属片刻字」「沈迟金属片」，还是对不上
 *   3. 子串包含   → 前缀是人名/形容词，「沈迟金属片」不含「金属片刻字」
 *
 * 真正稳定的信号：**归一化之后的最长公共子串**。
 * 「金属片刻字」和「沈迟金属片」的 LCS 是「金属片」——正好是要识别的那个物件。
 */
function findHook(memory, name, opts = {}) {
  if (!name) return null;
  const exact = memory.hooks.find(h => h.title === name);
  if (exact) return exact;

  const pool = opts.includeClosed
    ? memory.hooks
    : memory.hooks.filter(h => h.status === HOOK_STATE.open);
  if (!pool.length) return null;

  const a = normTitle(name);
  if (a.length < 2) return null;
  const aCodes = extractCodes(a);

  // 第 1 层：编号相同（B7、017 这种，唯一性最强）
  if (aCodes.length) {
    for (const h of pool) {
      const bCodes = extractCodes(normTitle(h.title));
      if (bCodes.some(c => aCodes.includes(c))) return h;
    }
  }

  // 第 2 层：子串包含（短的被长的包住）
  for (const h of pool) {
    const b = normTitle(h.title);
    if (b.length < 2) continue;
    if (a.includes(b) || b.includes(a)) return h;
  }

  // 第 3 层：最长公共子串 ≥ 3 字
  // 「金属片刻字」vs「沈迟金属片」→ LCS = 金属片（3字）✓
  // 「林雾的项链」vs「沈迟的头痛」→ LCS = 0，不匹配 ✓
  const MIN_LCS = 3;
  let best = null, bestLen = 0;
  for (const h of pool) {
    const b = normTitle(h.title);
    const l = longestCommonSubstr(a, b);
    if (l > bestLen) { bestLen = l; best = h; }
  }
  return bestLen >= MIN_LCS ? best : null;
}

/** 最长公共子串长度 */
function longestCommonSubstr(x, y) {
  if (!x || !y) return 0;
  let best = 0;
  // y 短、x 长，用滚动数组省内存
  const [s, l] = x.length < y.length ? [x, y] : [y, x];
  const prev = new Array(s.length + 1).fill(0);
  for (let i = 1; i <= l.length; i++) {
    const cur = new Array(s.length + 1).fill(0);
    for (let j = 1; j <= s.length; j++) {
      if (l[i - 1] === s[j - 1]) {
        cur[j] = prev[j - 1] + 1;
        if (cur[j] > best) best = cur[j];
      }
    }
    for (let j = 0; j <= s.length; j++) prev[j] = cur[j];
  }
  return best;
}

function normTitle(s) {
  return String(s || '')
    .replace(/[的地得了着过和与及]/g, '')
    .replace(/[0-9]{4}年?/g, '')
    .replace(/第[一二三四五六七八九十百]+[层级章节页条个次]/g, '')
    .replace(/(一块|一张|一枚|一道|一串|一只|一把|一部|一封|一份|那|这|上|中|里|内|背面|正面|表面|旁边|原始)/g, '')
    .replace(/[「」『』""''《》]/g, '')
    .replace(/\s+/g, '')
    .trim();
}

function extractCodes(s) {
  return (String(s).match(/[A-Za-z]*\d+[A-Za-z0-9]*/g) || []).filter(x => x.length >= 2);
}

/**
 * 核心词：把「修饰的人/地/数量/位置」剥掉，剩下可能指同一个物件的部分。
 * 「缺失的015与016金属片」→ ['金属片']（编号单独处理）
 * 「权限卡上的划痕」→ ['权限卡', '划痕']
 */
function coreWords(s) {
  const codes = extractCodes(s);
  const parts = String(s)
    .replace(/[A-Za-z]*\d+[A-Za-z0-9]*/g, '|')   // 编号挖走，留分隔符
    .split(/[|、，,。：:；;（）()\[\]【】\-—_/\\]+/)
    .filter(Boolean);
  const words = [];
  for (const p of parts) {
    if (p.length >= 2) words.push(p);
    if (p.length > 4) {                       // 长词额外切三字片段
      for (let i = 0; i < p.length - 3; i += 3) words.push(p.slice(i, i + 3));
    }
  }
  return [...new Set([...words, ...codes])];
}

/**
 * 从设定初始化记忆层
 */
export function initMemory(bible) {
  return {
    canon: {
      world: bible.world.map(w => ({ name: w.name, rule: w.rule })),
      characters: bible.characters.map(c => ({
        name: c.name, want: c.want, wound: c.wound, voice: c.voice,
        fixed: true,   // 核心设定，自动流程不改
      })),
      factions: bible.factions || [],   // 势力：{name, goal, colorHint}
    },
    state: {
      clock: '第 1 天',
      characters: bible.characters.map(c => ({
        name: c.name, where: c.where || '', condition: c.state || '未交代',
        faction: c.faction || '',        // 属于哪个势力
        alive: true,
        attributes: c.attributes || {}, // 关键属性：{位置: 值}
        lastSeenIn: 1,                   // 最后出场章
      })),
      threads: [],
    },
    // 关系是有向的：A 对 B 的关系 ≠ B 对 A 的关系
    // kind: ally 同盟 / enemy 敌对 / master 从属 / debt 亏欠 / unknows 互不相识
    relations: [],   // {from, to, kind, label, since, until}
    // 时间线：每章一个节点，串起所有状态变化
    timeline: [],   // {chapter, events: [{kind, text}], clock}
    hooks: bible.foreshadows.map(f => ({
      id: `h_init_${f.id || f.title}`,
      title: f.title,
      detail: f.note || '',
      payPlan: '',
      plantedIn: f.plantedIn || 1,
      status: HOOK_STATE.open,
    })),
    chapters: [],
    updatedAt: new Date().toISOString(),
  };
}

/** 记忆层的体检：告诉你哪里该补了 */
export function memoryHealth(memory, currentChapter) {
  const open = memory.hooks.filter(h => h.status === HOOK_STATE.open);
  const overdue = open.filter(h => {
    const p = hookPressure(h, currentChapter);
    return p && (p.level === 'overdue' || p.level === 'rotten');
  });
  const paid = memory.hooks.filter(h => h.status === HOOK_STATE.closed);
  const openThreads = memory.state.threads.filter(t => t.status === 'open');

  return {
    openHooks: open.length,
    closedHooks: paid.length,
    overdueHooks: overdue.length,
    overdueList: overdue,
    openThreads: openThreads.length,
    avgHookLife: paid.length
      ? Math.round(paid.reduce((n, h) => n + (h.closedIn - h.plantedIn), 0) / paid.length)
      : null,
    lastChapterNum: memory.chapters.length
      ? memory.chapters[memory.chapters.length - 1].num
      : 0,
  };
}
