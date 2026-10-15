/**
 * 会话 / 消息存储（按用户分区）
 * ============================
 *
 * 改造要点：原来是一个模块级的 better-sqlite3 单例（data/chat.db），
 * 所有人共用一个库。现在每个用户一个库：`data/users/<uid>/chat.db`。
 *
 * 实现方式：对外导出的函数名、参数、返回值**完全不变**，
 * 内部通过 AsyncLocalStorage 里的当前用户上下文懒加载对应的库。
 * 这样 index.ts 里 15 处 db.xxx 调用一行都不用改，也不会有人漏改。
 */

import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { currentUser, tryCurrentUser } from './users.js';

// 类型定义
export interface DbSession {
  id: string;
  title: string;
  model: string;
  sdk_session_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface DbMessage {
  id: string;
  session_id: string;
  role: 'user' | 'assistant';
  content: string;
  model: string | null;
  created_at: string;
  tool_calls: string | null;
}

type DbInstance = InstanceType<typeof Database>;

/** 每个用户一个连接，进程内缓存 */
const instances = new Map<string, DbInstance>();

function openDb(dir: string): DbInstance {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const instance = new Database(path.join(dir, 'chat.db'));
  instance.pragma('journal_mode = WAL');
  instance.exec(`
    -- 会话表
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      model TEXT NOT NULL,
      sdk_session_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    -- 消息表
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
      content TEXT NOT NULL,
      model TEXT,
      created_at TEXT NOT NULL,
      tool_calls TEXT,
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_messages_session_id ON messages(session_id);
  `);

  // 迁移：补 sdk_session_id 列
  try {
    const info = instance.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>;
    if (!info.some((c) => c.name === 'sdk_session_id')) {
      instance.exec('ALTER TABLE sessions ADD COLUMN sdk_session_id TEXT');
    }
  } catch {
    /* 忽略 */
  }

  return instance;
}

/** 取当前请求所属用户的数据库连接 */
function db(): DbInstance {
  const ctx = currentUser();
  let inst = instances.get(ctx.uid);
  if (!inst) {
    inst = openDb(ctx.dir);
    instances.set(ctx.uid, inst);
  }
  return inst;
}

/** 某个用户是否已经有会话数据（用于前端提示「你有历史作品」） */
export function userHasChatData(uid: string, dir: string): boolean {
  try {
    const inst = instances.get(uid) ?? openDb(dir);
    instances.set(uid, inst);
    const row = inst.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number };
    return row.n > 0;
  } catch {
    return false;
  }
}

/** 关闭某个用户的库连接（删除身份时用） */
export function closeUserDb(uid: string): void {
  const inst = instances.get(uid);
  if (inst) {
    try {
      inst.close();
    } catch {
      /* ignore */
    }
    instances.delete(uid);
  }
}

/* ============= 会话操作 ============= */

export function getAllSessions(): DbSession[] {
  return db().prepare('SELECT * FROM sessions ORDER BY updated_at DESC').all() as DbSession[];
}

export function getSession(id: string): DbSession | undefined {
  return db().prepare('SELECT * FROM sessions WHERE id = ?').get(id) as DbSession | undefined;
}

export function createSession(session: DbSession): DbSession {
  db()
    .prepare(
      `INSERT INTO sessions (id, title, model, sdk_session_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      session.id,
      session.title,
      session.model,
      session.sdk_session_id,
      session.created_at,
      session.updated_at,
    );
  return session;
}

export function updateSession(
  id: string,
  updates: Partial<Pick<DbSession, 'title' | 'model' | 'sdk_session_id'>>,
): boolean {
  const fields: string[] = [];
  const values: any[] = [];

  if (updates.title !== undefined) {
    fields.push('title = ?');
    values.push(updates.title);
  }
  if (updates.model !== undefined) {
    fields.push('model = ?');
    values.push(updates.model);
  }
  if (updates.sdk_session_id !== undefined) {
    fields.push('sdk_session_id = ?');
    values.push(updates.sdk_session_id);
  }
  if (fields.length === 0) return false;

  fields.push('updated_at = ?');
  values.push(new Date().toISOString());
  values.push(id);

  const result = db().prepare(`UPDATE sessions SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  return result.changes > 0;
}

export function deleteSession(id: string): boolean {
  return db().prepare('DELETE FROM sessions WHERE id = ?').run(id).changes > 0;
}

/* ============= 消息操作 ============= */

export function getMessagesBySession(sessionId: string): DbMessage[] {
  return db()
    .prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC')
    .all(sessionId) as DbMessage[];
}

export function createMessage(message: DbMessage): DbMessage {
  const instance = db();
  instance
    .prepare(
      `INSERT INTO messages (id, session_id, role, content, model, created_at, tool_calls)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      message.id,
      message.session_id,
      message.role,
      message.content,
      message.model,
      message.created_at,
      message.tool_calls,
    );

  instance.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(new Date().toISOString(), message.session_id);
  return message;
}

export function updateMessage(id: string, updates: Partial<Pick<DbMessage, 'content' | 'tool_calls'>>): boolean {
  const fields: string[] = [];
  const values: any[] = [];

  if (updates.content !== undefined) {
    fields.push('content = ?');
    values.push(updates.content);
  }
  if (updates.tool_calls !== undefined) {
    fields.push('tool_calls = ?');
    values.push(updates.tool_calls);
  }
  if (fields.length === 0) return false;

  values.push(id);
  return db().prepare(`UPDATE messages SET ${fields.join(', ')} WHERE id = ?`).run(...values).changes > 0;
}

export function deleteMessage(id: string): boolean {
  return db().prepare('DELETE FROM messages WHERE id = ?').run(id).changes > 0;
}

export function createMessages(messages: DbMessage[]): void {
  const instance = db();
  const stmt = instance.prepare(
    `INSERT INTO messages (id, session_id, role, content, model, created_at, tool_calls)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertMany = instance.transaction((msgs: DbMessage[]) => {
    for (const msg of msgs) {
      stmt.run(msg.id, msg.session_id, msg.role, msg.content, msg.model, msg.created_at, msg.tool_calls);
    }
  });
  insertMany(messages);
}

export function clearAllData(): void {
  const instance = db();
  instance.exec('DELETE FROM messages');
  instance.exec('DELETE FROM sessions');
}

/** 当前是否处于用户上下文中（部分老代码路径用来兜底） */
export function hasUserContext(): boolean {
  return tryCurrentUser() !== null;
}
