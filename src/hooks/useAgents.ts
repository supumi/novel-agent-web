import { useState, useEffect, useCallback } from 'react';
import { CustomAgent } from '../types';
import { v4 as uuidv4 } from 'uuid';

const STORAGE_KEY = 'customAgents';

// 默认的 Agent：小说创作助手
export const NOVEL_SYSTEM_PROMPT = `你是「小说创作助手」——一位懂网文节奏、也懂怎么把 AI 味压下去的中文小说共创者。
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
- 默认输出中文正文 2000–3000 字。
- 若工作目录里有小说工程文件（如 data/state.json、export/），可读取它作为记忆来源。`;

const DEFAULT_AGENT: CustomAgent = {
  id: 'default',
  name: '小说创作助手',
  description: '续写章节 · 记忆卡 · 钩子压力 · 一致性校验 · AI 痕迹体检',
  systemPrompt: NOVEL_SYSTEM_PROMPT,
  icon: 'Sparkles',
  color: '#7c3aed',
  createdAt: new Date(),
  updatedAt: new Date(),
};

export function useAgents() {
  const [agents, setAgents] = useState<CustomAgent[]>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        return [DEFAULT_AGENT, ...parsed.map((a: any) => ({
          ...a,
          createdAt: new Date(a.createdAt),
          updatedAt: new Date(a.updatedAt),
        }))];
      }
    } catch (e) {
      console.error('Failed to load agents:', e);
    }
    return [DEFAULT_AGENT];
  });

  // 保存到 localStorage（排除默认 agent）
  const saveAgents = useCallback((newAgents: CustomAgent[]) => {
    const toSave = newAgents.filter(a => a.id !== 'default');
    localStorage.setItem(STORAGE_KEY, JSON.stringify(toSave));
  }, []);

  const addAgent = useCallback((agent: Omit<CustomAgent, 'id' | 'createdAt' | 'updatedAt'>) => {
    const newAgent: CustomAgent = {
      ...agent,
      id: uuidv4(),
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    setAgents(prev => {
      const updated = [...prev, newAgent];
      saveAgents(updated);
      return updated;
    });
    return newAgent;
  }, [saveAgents]);

  const updateAgent = useCallback((id: string, updates: Partial<Omit<CustomAgent, 'id' | 'createdAt'>>) => {
    setAgents(prev => {
      const updated = prev.map(a => 
        a.id === id ? { ...a, ...updates, updatedAt: new Date() } : a
      );
      saveAgents(updated);
      return updated;
    });
  }, [saveAgents]);

  const deleteAgent = useCallback((id: string) => {
    if (id === 'default') return; // 不能删除默认 agent
    setAgents(prev => {
      const updated = prev.filter(a => a.id !== id);
      saveAgents(updated);
      return updated;
    });
  }, [saveAgents]);

  const getAgent = useCallback((id: string) => {
    return agents.find(a => a.id === id);
  }, [agents]);

  return {
    agents,
    addAgent,
    updateAgent,
    deleteAgent,
    getAgent,
    defaultAgent: DEFAULT_AGENT,
  };
}
