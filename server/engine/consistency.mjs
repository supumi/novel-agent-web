// 一致性校验：找世界观崩掉的地方
//
// 关系图是给人看的，校验是给机器用的。
// 真正让长篇崩的不是「画不出图」，是「写着写着自己打自己」：
//   · 死人又出现了
//   · 已经决裂的两个人又在合作
//   · 换了阵营的人还按老立场行动
//   · 关系形成 A→B→C→A 的荒谬循环
//   · 关键属性前后矛盾（上一章说左手，这一章说右手）
//
// 这些必须在写下一章**之前**发现，而不是等读者发现。

/** 校验结果里最严重的级别 */
export const SEVERITY = {
  fatal: 'fatal',      // 逻辑上不可能，必须改
  warn: 'warn',        // 可疑，人看一眼决定
  info: 'info',        // 提醒
};

export function validate(memory, currentChapter) {
  const issues = [];
  const chars = memory.state.characters;
  const byName = new Map(chars.map(c => [c.name, c]));

  /* ---- 1. 死人复活 ---- */
  for (const c of chars) {
    if (c.alive === false) {
      const diedIn = c.diedIn;
      // 死人之后又出现，就是硬伤
      if (c.lastSeenIn && diedIn && c.lastSeenIn > diedIn) {
        issues.push({
          severity: SEVERITY.fatal,
          kind: 'dead_alive',
          title: '死者复现',
          text: `${c.name} 在第 ${diedIn} 章已经死了，但第 ${c.lastSeenIn} 章又出场了。`,
          fix: `二选一：改第 ${c.lastSeenIn} 章的出场描述，或把死亡时���往后挪。`,
        });
      }
    }
  }

  /* ---- 2. 关系矛盾 ---- */
  const rels = memory.relations.filter(r => r.until == null);
  const relKey = (a, b) => `${a}|${b}`;

  for (const r of rels) {
    // 已死亡的人不该还有活跃关系
    const fromDead = byName.get(r.from)?.alive === false;
    const toDead = byName.get(r.to)?.alive === false;
    if (r.kind === 'ally' && (fromDead || toDead)) {
      const deadName = fromDead ? r.from : r.to;
      issues.push({
        severity: SEVERITY.warn,
        kind: 'relation_with_dead',
        title: '关系涉及死者',
        text: `${r.from} → ${r.to} 仍是「同盟」关系，但${deadName}已经死了（第 ${byName.get(deadName).diedIn} 章）。`,
        fix: `结束这条关系（kind 改 broken），或者确认这是死者留下的历史关系。`,
      });
    }
    // 决裂了还同盟
    if (r.kind === 'broken' && (r.until == null)) {
      issues.push({
        severity: SEVERITY.info,
        kind: 'broken_still_active',
        title: '已结束的关系没关掉',
        text: `${r.from} → ${r.to} 标记为 broken，但没有结束章数。`,
        fix: '补 until 章数，否则会一直算作活跃关系。',
      });
    }
  }

  /* ---- 3. 双向矛盾：A 恨 B 但 B 爱 A 不算矛盾（正常），
        真正矛盾是 A 说 B 是敌人，B 自己说 A 是敌人（对不上）---- */
  for (let i = 0; i < rels.length; i++) {
    for (let j = i + 1; j < rels.length; j++) {
      const a = rels[i], b = rels[j];
      if (a.from === b.to && a.to === b.from) {
        // 双向关系检查：不应同时是 master 和 enemy
        if (a.kind === 'master' && b.kind === 'master') {
          issues.push({
            severity: SEVERITY.fatal,
            kind: 'double_master',
            title: '双向从属',
            text: `${a.from} 是 ${a.to} 的上级，同时 ${b.from} 又是 ${b.to} 的上级。`,
            fix: '只能有一个方向成立，另一条应该是 ally 或 enemy。',
          });
        }
        if (a.kind === 'ally' && b.kind === 'enemy') {
          issues.push({
            severity: SEVERITY.warn,
            kind: 'ally_enemy_mirror',
            title: '关系不对称',
            text: `${a.from} 认为和 ${a.to} 是盟友，但 ${a.to} 认为和 ${a.from} 是敌对。`,
            fix: '确认是不是故意的（表面盟友暗中敌对），否则是写错了。',
          });
        }
      }
    }
  }

  /* ---- 4. 阵营一致性 ---- */
  const factionMembers = {};
  for (const c of chars) {
    if (!c.faction) continue;
    (factionMembers[c.faction] = factionMembers[c.faction] || []).push(c.name);
  }
  for (const r of rels) {
    if (r.kind !== 'ally') continue;
    const a = byName.get(r.from), b = byName.get(r.to);
    if (!a?.faction || !b?.faction) continue;
    if (a.faction !== b.faction) {
      issues.push({
        severity: SEVERITY.info,
        kind: 'cross_faction_ally',
        title: '跨阵营同盟',
        text: `${r.from}（${a.faction}）和 ${r.to}（${b.faction}）是盟友。`,
        fix: '如果是卧底或临时合作就没事，否则阵营设定可能有问题。',
      });
    }
  }

  /* ---- 5. 关系环：检查有没有荒谬的循环 ---- */
  // 2026-10-05 修：原来的实现把 seen 和 path 混用，
  // 逻辑上永远走不到「回到已访问节点」的分支，成环检测形同虚设。
  // 改成标准 DFS + 递归栈判环。
  const graph = {};
  for (const r of rels) {
    if (r.kind === 'enemy') continue;      // 敌对关系可以绕圈
    (graph[r.from] = graph[r.from] || []).push(r.to);
  }

  const cycles = [];
  const WHITE = 0, GRAY = 1, BLACK = 2;   // 未访问 / 在栈上 / 已完成
  const color = {};
  const stack = [];

  function dfs(node) {
    color[node] = GRAY;
    stack.push(node);
    for (const next of (graph[node] || [])) {
      if (color[next] === GRAY) {
        // 找到回边 → 有环
        const idx = stack.indexOf(next);
        const cyc = stack.slice(idx);
        const key = [...cyc].sort().join('|');
        if (!cycles.find(c => c.key === key)) {
          cycles.push({ key, nodes: cyc });
        }
      } else if (!color[next]) {
        dfs(next);
      }
    }
    stack.pop();
    color[node] = BLACK;
  }

  for (const n of Object.keys(graph)) {
    if (!color[n]) dfs(n);
  }

  for (const c of cycles) {
    // 自己指向自己是环
    if (c.nodes.length === 1) {
      issues.push({
        severity: SEVERITY.warn,
        kind: 'relation_self',
        title: '自己跟自己有关系',
        text: `${c.nodes[0]} 的关系指向自己。`,
        fix: '多半是抽取时把 from 和 to 填成了同一个名字。',
      });
      continue;
    }
    // 2026-10-06 修：A→B 和 B→A 同时存在是**正常的双向不对称**
    // （比如「A 觉得是盟友，B 还不知道 B 是谁」），不是环。
    // 真正的环需要 3 个以上的节点，或者自己指自己。
    if (c.nodes.length === 2) continue;
    issues.push({
      severity: SEVERITY.warn,
      kind: 'relation_cycle',
      title: '关系闭环',
      text: `${c.nodes.join(' → ')} → ${c.nodes[0]}。`,
      fix: '从属或同盟关系不该成环。检查是不是两人都标了对方的上级。',
    });
  }

  /* ---- 6. 钩子与关系的交叉：伏笔涉及的人死了 ---- */
  for (const h of memory.hooks) {
    if (h.status !== 'open') continue;
    for (const c of chars) {
      if (c.alive !== false) continue;
      if (h.title.includes(c.name) || (h.detail || '').includes(c.name)) {
        issues.push({
          severity: SEVERITY.fatal,
          kind: 'hook_dead',
          title: '伏笔挂在死人身上',
          text: `伏笔「${h.title}」涉及 ${c.name}，但他已经死了（第 ${c.diedIn} 章）。`,
          fix: '这条伏笔没法收了，要么改设定，要么让死者留下能收的东西（遗物、信件）。',
        });
      }
    }
  }

  /* ---- 7. 属性矛盾：同一属性出现互斥的值 ---- */
  const MUTEX = [
    { key: '立场', values: ['维护秩序', '推翻秩序'], note: '立场不能既是维护又是推翻' },
    { key: '效忠对象', note: '同时效忠两个敌对势力是矛盾的' },
  ];
  for (const m of MUTEX) {
    for (const c of chars) {
      const v = c.attributes?.[m.key];
      if (v && m.values && m.values.length === 2 && v.includes(m.values[0]) && v.includes(m.values[1])) {
        issues.push({
          severity: SEVERITY.fatal,
          kind: 'mutex_attribute',
          title: '属性自相矛盾',
          text: `${c.name} 的「${m.key}」同时包含 ${m.values.join(' 和 ')}。${m.note || ''}`,
          fix: '改成单一值，或换个措辞。',
        });
      }
    }
  }

  /* ---- 汇总 ---- */
  const fatal = issues.filter(i => i.severity === SEVERITY.fatal);
  const warn = issues.filter(i => i.severity === SEVERITY.warn);

  return {
    issues,
    fatalCount: fatal.length,
    warnCount: warn.length,
    ok: fatal.length === 0,
    stats: {
      characters: chars.length,
      alive: chars.filter(c => c.alive !== false).length,
      dead: chars.filter(c => c.alive === false).length,
      factions: Object.keys(factionMembers).length,
      relations: rels.length,
      byFaction: factionMembers,
    },
  };
}

/**
 * 把校验结果变成给模型看的警告，塞进下一章的记忆卡。
 * 目的是让模型**自己避免**打自己的脸，而不是等发现完再去改。
 */
export function validatePrompt(issues) {
  const fatal = issues.filter(i => i.severity === SEVERITY.fatal);
  if (!fatal.length) return '';
  return `

【硬约束 · 以下已有矛盾，不要再犯】
${fatal.map(i => `· ${i.text} ${i.fix}`).join('\n')}`;
}
