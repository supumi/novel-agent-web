// AI 痕迹检测器（去 AI 味体检）
// 目的：把「一眼看出是 AI 写的」这件事从直觉变成可执行的规则
// 定位：不是禁止这些写法，而是标出来让你自己决定要不要改

/**
 * 每条规则：
 *   id       唯一标识
 *   label    名称
 *   desc     为什么这是痕迹
 *   severity high | mid | low
 *   test     (line) => 命中位置数组；不命中返回 []
 *   suggest  修改方向
 */

// —— 结构型：这类是最致命的，因为读者说不清为什么别扭 ——

const RULES = [
  {
    id: 'aphorism',
    label: '格言化收尾',
    desc: '段落末尾用一句抽象总结收束。这是 AI 最强的指纹之一——真人很少这样收尾，但 AI 几乎每段都想总结点什么。',
    severity: 'high',
    test: line => {
      const out = [];
      const pats = [
        /有些[^。！？]{0,10}就[^。！？]{0,12}再也/g,
        /(终于)?(明白|意识到)了?[^。！？]{0,4}，[一-龥]{4,24}/g,
        /再也(不会|不能|回不到|关不上|放不下|留不下|想不起)/g,
        /^(他|她)?(终于)?(懂了|看清了|想通了)[，。]/g,
        /有些事[^。！？]{0,6}(不说|收不回来|回不来)/g,
      ];
      for (const p of pats) {
        for (const m of line.matchAll(p)) out.push(m.index);
      }
      return out;
    },
    suggest: '删掉这句总结，让动作或对话自己收尾。读者会自己得出结论。',
  },
  {
    id: 'contrast-beat',
    label: '两段对照句',
    desc: '「他没有回答。有些事…」——用否定句起头、再用一句总结收尾，是模型模仿「留白」时的固定套路。',
    severity: 'high',
    test: line => {
      const out = [];
      // 「他没有回答。某些事…」——否定句独立成句 + 紧跟一个总结短句
      const re = /[^。！？\n]{0,10}?(?:没有|不|没)(?:回答|说话|吭声|理会|接话|吭)[。！？]\s*[^。！？\n]{4,22}[。！？]/g;
      for (const m of line.matchAll(re)) out.push(m.index);
      return out;
    },
    suggest: '删掉后半句的总结，或把它换成对方的动作/环境反应。',
  },
  {
    id: 'neat-trio',
    label: '排比过于工整',
    desc: '三个及以上结构对称的短句，或「你不会X。X了，你也Y」这类回环。真人写手不把句子排得太整齐。',
    severity: 'mid',
    test: line => {
      const out = [];
      // 切句，取连续 3+ 句长度相近（公差 2）即视为工整排比
      const parts = [...line.matchAll(/[^。！？\n]+[。！？]/g)]
        .map(m => ({ s: m.index, len: m[0].replace(/[，。！？、]/g, '').length }));
      for (let i = 0; i + 2 < parts.length; i++) {
        const [a, b, c] = [parts[i], parts[i + 1], parts[i + 2]];
        if (!a.len || !b.len || !c.len) continue;
        const max = Math.max(a.len, b.len, c.len);
        const min = Math.min(a.len, b.len, c.len);
        if (max - min <= 2 && min >= 2) out.push(a.s);
      }
      // 回环结构：「你不会信。信了，你也…」——重复词在下一句开头。
      // 单字回环（「信。信了」）要抓，但会误伤「屋檐还在滴水。水滴砸在…」
      // 这种「上一句末字 = 下一句首字」的正常衔接。
      // 区分办法：单字回环时，后面必须跟动词性成分（了/着/过/起/来/去）。
      for (const m of line.matchAll(/([^。！？]{2,6})[，]?([^。！？]{1,6})[。！？]\s*\2/g)) {
        const single = m[2].length === 1;
        const rest = line.slice(m.index + m[0].length);
        const isVerbTail = single && /^[了着过起来去]/.test(rest);
        const isWordTail = !single;
        if (isWordTail || isVerbTail) out.push(m.index);
      }
      return out;
    },
    suggest: '打破对称：把其中一个分句改成长句，或插一个具体的动作打断节奏。',
  },

  // —— 用词型 ——

  {
    id: 'self-comparative',
    label: '自我指涉比较级',
    desc: '「声音比自己预想的要低」——AI 特别喜欢用「比X预想的/想象的」来限定程度，因为这样显得细腻。',
    severity: 'high',
    test: line => {
      const out = [];
      const re = /比(自己|他|她|我|原先|以往)[^。]{0,4}(预想|想象|预料|以为|想的)[^。]{0,8}/g;
      for (const m of line.matchAll(re)) out.push(m.index);
      return out;
    },
    suggest: '直接写声音本身：「他压低了声音」。删掉比较结构。',
  },
  {
    id: 'vague-simile',
    label: '模糊抽象比喻',
    desc: '「像在数着什么」「像是在等一个不会回来的人」——比喻的本体是抽象的情绪或动作，不是具体可感的东西。',
    severity: 'high',
    test: line => {
      const out = [];
      const pats = [
        /像(?:是|像是)?在[^。！？]{0,3}(?:着|什么|着什?么)/g,
        // 抽象本体：等/守/看/陪 某人回来、走、消失 —— 具体物件不会这样被比喻
        /像(?:是|像是)?(?:在|正)?(?:等|守|看|陪|替|给)[^。！？]{0,6}(?:回来|走|消失|结束|不见|老去|长大|来)/g,
        /像(?:是|像是)?(?:在)?(?:数着|算着|等着|守着|记着)[^。！？]{0,4}什么/g,
      ];
      for (const p of pats) {
        for (const m of line.matchAll(p)) out.push(m.index);
      }
      return out;
    },
    suggest: '换成具体的物理意象：滴水声、灰尘、锈迹、别人袖口的线头。抽象比喻是 AI 的安全区，真人不敢这么写。',
  },
  {
    id: 'emotion-label',
    label: '情绪直陈',
    desc: '「他感到一阵」「心中充满了」「他很愤怒」——直接命名情绪，而不是呈现它。',
    severity: 'high',
    test: line => {
      const out = [];
      const pats = [
        /(他|她|我)(感到|感觉到|体验到)[^。]{0,6}[一-龥]/g,
        /心中(充满|涌起|泛起)[^。]{0,8}/g,
        /(他|她)(很|非常|极其)(愤怒|难过|开心|害怕|紧张|激动|绝望|兴奋)/g,
      ];
      for (const p of pats) {
        for (const m of line.matchAll(p)) out.push(m.index);
      }
      return out;
    },
    suggest: '删掉情绪词，改用生理反应或动作：「他的手停在门把上，没按下去。」',
  },
  {
    id: 'universal-scene',
    label: '万能环境描写',
    desc: '「月光洒在…上」「空气中弥漫着…的气息」「风吹过…」——网文 AI 的场景模板。',
    severity: 'mid',
    test: line => {
      const out = [];
      const pats = [
        /(月光|阳光|夕阳|晨光)(洒|照|落在)[^。]{0,12}上/g,
        /空气中(弥漫|飘着|浮着)[^。]{0,10}(气息|味道)/g,
        /(风|微风|晚风)(吹过|拂过|掠过)[^。]{0,12}/g,
      ];
      for (const p of pats) {
        for (const m of line.matchAll(p)) out.push(m.index);
      }
      return out;
    },
    suggest: '换成这个场景独有的细节。泛用的光和风放之四海皆准，正是可疑之处。',
  },

  // —— 标点型 ——

  {
    id: 'quote-spacing',
    label: '引号内多余空格',
    desc: '「…… 」引号内前后加空格，是非中文母语模型或某些 tokenizer 的输出习惯，简体网文不该有。',
    severity: 'low',
    test: line => {
      const out = [];
      for (const m of line.matchAll(/「\s+[^」]*|\S\s+」/g)) out.push(m.index);
      return out;
    },
    suggest: '删掉引号内的空格。',
  },
  {
    id: 'speech-tag',
    label: '对话标签模板化',
    desc: '「X说，声音比…」这种「说 + 逗号 + 补充描述」的句式密度过高，是 AI 的标志性节奏。',
    severity: 'mid',
    test: line => {
      const hits = line.match(/(说|问|答)[，,]\s*[^。！？]{2,20}[。！？]/g);
      return hits ? hits.map(() => 0) : [];
    },
    suggest: '把补充描述拆成独立动作，或直接删掉。让对话自己带情绪。',
  },
  {
    id: 'filler',
    label: '解释性填充词',
    desc: '「其实」「显然」「当然」「不知为何」——AI 用来制造转折感的连接词，真人很少用。',
    severity: 'low',
    test: line => {
      const out = [];
      for (const m of line.matchAll(/(不知为何|不知道的是|值得注意|不可否认|显而易见)/g)) out.push(m.index);
      return out;
    },
    suggest: '删掉。转折靠句序，不靠连接词宣告。',
  },
];

/**
 * 检测一段正文
 * @returns {
 *   score: 0-100  越低越像人写的（不是绝对标准，只是相对参考）
 *   hits: [{ ruleId, label, desc, severity, line, col, excerpt, suggest }]
 *   stats: { chars, sentences, avgSentenceLen, hitCount, bySeverity }
 * }
 */
export function lint(text) {
  if (!text || !text.trim()) {
    return {
      score: 0, grade: 'clean', hits: [],
      stats: {
        chars: 0, sentences: 0, avgSentenceLen: 0, hitCount: 0,
        bySeverity: { high: 0, mid: 0, low: 0 }, perSentence: 0, highPerSentence: 0,
      },
    };
  }

  const lines = text.split('\n');
  const hits = [];

  lines.forEach((line, li) => {
    if (!line.trim()) return;
    for (const rule of RULES) {
      let positions = [];
      try { positions = rule.test(line) || []; } catch { positions = []; }
      for (const col of positions) {
        hits.push({
          ruleId: rule.id,
          label: rule.label,
          desc: rule.desc,
          severity: rule.severity,
          suggest: rule.suggest,
          line: li + 1,
          col,
          excerpt: line.slice(Math.max(0, col - 12), col + 30),
        });
      }
    }
  });

  // 去重：同一行同一规则只保留一处
  const seen = new Set();
  const uniq = hits.filter(h => {
    const k = `${h.line}:${h.ruleId}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  const chars = text.replace(/\s/g, '').length;
  const sentences = (text.match(/[。！？…]/g) || []).length || 1;
  const bySeverity = { high: 0, mid: 0, low: 0 };
  for (const h of uniq) bySeverity[h.severity]++;

  // 评分：按「每句平均痕迹数」算，而不是每百字。
  // 理由：痕迹是句级现象，按字数归一会让短文本（哪怕只一句）
  // 立刻封顶，失去区分度。
  // 分母留 3 句基准：文本太短时不至于一命中就打满，否则分数噪声大。
  const weighted = bySeverity.high * 3 + bySeverity.mid * 1.5 + bySeverity.low * 0.5;
  const denom = Math.max(sentences, 3);
  const perSentence = weighted / denom;
  // 每句 0.4 个加权痕迹 → 约 60 分；1.2 个 → 接近满分
  const score = Math.max(0, Math.min(100, Math.round((perSentence / 1.2) * 100)));

  // 另给一个「高危密度」，供 UI 单独提示
  const highPerSentence = bySeverity.high / sentences;

  return {
    score,
    grade: score >= 70 ? 'obvious' : score >= 40 ? 'suspect' : score >= 15 ? 'mild' : 'clean',
    hits: uniq.sort((a, b) => (a.line - b.line) || (a.col - b.col)),
    stats: {
      chars,
      sentences,
      avgSentenceLen: Math.round(chars / sentences),
      hitCount: uniq.length,
      bySeverity,
      perSentence: Number(perSentence.toFixed(2)),
      highPerSentence: Number(highPerSentence.toFixed(2)),
    },
  };
}

/** 只返回分数，快速自检用 */
export function score(text) {
  return lint(text).score;
}

export const RULE_LIST = RULES.map(r => ({
  id: r.id, label: r.label, desc: r.desc, severity: r.severity, suggest: r.suggest,
}));

/**
 * 生成给模型的「去 AI 味」写作约束
 * 挂在草稿关卡的 system prompt 后面，供真实 LLM 使用
 */
export function antiAIPrompt() {
  return `

【写作约束 · 反 AI 腔】
以下是我们检测到的高频 AI 痕迹，本篇严禁出现：

1. 不要用格言式总结收尾。「有些…就…再也…」「他终于明白…」这类一律禁止。
2. 不要「他没有回答。某些事…」这种否定句 + 总结的对照句式。
3. 不要三个以上结构对称的排比短句。
4. 不要「声音比自己预想的要低」这类「比X预想的」比较结构，直接写声音本身。
5. 不要抽象比喻。「像在数着什么」「像是在等一个不会回来的人」——比喻的本体必须是
   具体可感的东西（水声、灰尘、锈迹、别人袖口的线头），不是情绪词。
6. 不要直接命名情绪。禁止「感到」「心中充满」「很愤怒」，改用生理反应或动作。
7. 不要万能环境描写。「月光洒在…上」「空气中弥漫着…的气息」——换成这个场景
   独有的细节。
8. 对话标签不要用「说，补充描述」的模板句式。让对话本身带情绪。
9. 禁止使用「其实」「显然」「不知为何」这类解释性连接词。
10. 引号内不要加空格。

写作原则：写具体，不写感受。让人物做动作，让读者自己判断处境。
宁可平淡，不要工整。留白不等于总结。`;
}
