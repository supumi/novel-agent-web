// 小说生成流水线 · 数据模型定义
// 核心设计：把「状态变更」显式化。每个关卡的产出都是可读、可审、可回滚的对象。

/** 关卡定义 —— 顺序即流水线顺序 */
export const STAGES = [
  {
    key: 'bible',
    index: 1,
    name: '设定',
    en: 'Bible',
    purpose: '世界观、人物、伏笔表、章节规划',
    produces: 'bible + outline',
    needs: '一个创意种子',
  },
  {
    key: 'draft',
    index: 2,
    name: '草稿',
    en: 'Draft',
    purpose: '按设定写出本章正文',
    produces: 'chapter.content',
    needs: '设定 + 本章大纲 + 上一章结尾',
  },
  {
    key: 'harvest',
    index: 3,
    name: '回收',
    en: 'Harvest',
    purpose: '从正文里抽出状态变更，生成提案',
    produces: 'proposals[]',
    needs: '本章正文 + 当前设定',
    critical: true,
    note: '这是最容易被跳过、也最不能跳过的一关。正文里发生的事，如果不显式写回设定，就等于没发生过。',
  },
  {
    key: 'commit',
    index: 4,
    name: '定稿',
    en: 'Commit',
    purpose: '人工审阅提案，逐条接受或拒绝，然后写回设定',
    produces: 'bible 的增量更新 + 章节归档',
    needs: 'proposals[]',
  },
];

/** 提案类型 —— 决定 diff 的展示形态和写回目标 */
export const PROPOSAL_KINDS = {
  foreshadow_plant: {
    label: '埋下伏笔',
    target: 'foreshadows',
    color: 'amber',
    hint: '正文里出现了一个将来要回收的钩子',
  },
  foreshadow_pay: {
    label: '回收伏笔',
    target: 'foreshadows',
    color: 'teal',
    hint: '之前埋的钩子在这一章被用到',
  },
  character_update: {
    label: '人物变化',
    target: 'characters',
    color: 'blue',
    hint: '角色的状态、关系、认知发生了变化',
  },
  world_add: {
    label: '新增设定',
    target: 'world',
    color: 'purple',
    hint: '出现了新的世界观规则、地点、组织',
  },
  timeline: {
    label: '时间推进',
    target: 'timeline',
    color: 'gray',
    hint: '故事内时间前进，地点或阶段变化',
  },
  conflict: {
    label: '矛盾告警',
    target: null,
    color: 'red',
    hint: '正文与既有设定冲突，需要人判断',
    dangerous: true,
  },
  thread_open: {
    label: '开启支线',
    target: 'threads',
    color: 'green',
    hint: '出现了一个还没解决的新问题',
  },
  // —— 关系与阵营（2026-10-05 加）——
  // 这几类不进 bible，而是进 memory 的 relations / state，
  // 由 consistency.mjs 做校验。
  relation_change: {
    label: '关系变化',
    target: 'relations',
    color: 'blue',
    hint: '两个角色之间的关系变了（双向不对称）',
  },
  faction_change: {
    label: '阵营变化',
    target: 'state.faction',
    color: 'purple',
    hint: '角色转投了另一个势力',
  },
  death: {
    label: '死亡',
    target: 'state.alive',
    color: 'red',
    hint: '角色死了，之后不能出场',
    critical: true,
  },
  attribute: {
    label: '属性变化',
    target: 'state.attributes',
    color: 'gray',
    hint: '角色的关键属性变了（立场、能力、持有物）',
  },
  clock: {
    label: '时间推进',
    target: 'state.clock',
    color: 'gray',
    hint: '故事内时间往前走',
  },
};

/** 空项目模板 */
export function newProject(seed = '') {
  return {
    version: 1,
    id: `p_${Date.now().toString(36)}`,
    title: '未命名',
    seed,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    stage: 'bible',

    bible: {
      premise: '',        // 一句话故事
      world: [],          // {id, name, rule}
      characters: [],     // {id, name, role, want, wound, voice, state}
      foreshadows: [],    // {id, title, plantedIn, status, note}
      threads: [],        // {id, title, status, openedIn}
      timeline: [],       // {id, marker, note}
    },

    outline: [],          // {num, title, goal, beats[], targetWords}
    chapters: [],         // {num, title, content, summary, status, proposals, wordCount}
    currentChapter: 1,

    memory: null,         // 本地记忆层：{canon, state, hooks, chapters}
                         // canon 不可自动改；state 每章更新；hooks 带压力值

    log: [],              // {ts, stage, action, detail}
  };
}

/** 统计：这一步真正要看的数字 */
export function stats(project) {
  const words = project.chapters
    .filter(c => c.status === 'committed' || c.status === 'drafted')
    .reduce((n, c) => n + (c.wordCount || 0), 0);

  const planted = project.bible.foreshadows.filter(f => f.status === 'planted').length;
  const paid = project.bible.foreshadows.filter(f => f.status === 'paid').length;
  const openThreads = project.bible.threads.filter(t => t.status === 'open').length;

  return {
    words,
    chapters: project.chapters.length,
    committed: project.chapters.filter(c => c.status === 'committed').length,
    foreshadowsPlanted: planted,
    foreshadowsPaid: paid,
    foreshadowRatio: planted ? (paid / planted) : 0,
    openThreads,
    chars: project.bible.characters.length,
  };
}

/** 未决冲突：定稿前必须清零 */
export function pendingConflicts(project) {
  const out = [];
  for (const ch of project.chapters) {
    for (const p of ch.proposals || []) {
      if (p.kind === 'conflict' && p.status === 'pending') out.push({ chapter: ch.num, ...p });
    }
  }
  return out;
}

export function stageByKey(key) {
  return STAGES.find(s => s.key === key);
}

export function nextStage(key) {
  const i = STAGES.findIndex(s => s.key === key);
  return i >= 0 && i < STAGES.length - 1 ? STAGES[i + 1] : null;
}
