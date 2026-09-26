/*
 * Local storage: conversations, and which talents are installed.
 *
 * SQLITE VIA `bun:sqlite`, which is IN the runtime. No dependency, no native build step, no
 * `better-sqlite3` — the same argument as the standard library. The server already runs on bun,
 * so this costs nothing to adopt.
 *
 * WHAT IS DELIBERATELY NOT HERE: chain state.
 *
 * Balances, orders, positions — all derived, and all read live. Caching them would add a
 * staleness bug to a project that has already spent a session learning "executed is not
 * readable", and the outstanding tab's existing answer is the right one: read it, and say when
 * the snapshot was taken. A cache is a second source of truth for something the chain owns.
 *
 * So this holds what the chain CANNOT tell us: what was said, and what is installed.
 */

import { Database } from 'bun:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const DIR = process.env.SUI_DATA_DIR || 'data';
const FILE = path.join(DIR, 'sui-tokyo.db');

/**
 * The schema, applied on every open.
 *
 * `CREATE TABLE IF NOT EXISTS` rather than a migration runner: there is one deployment, it is
 * local, and a version table for a database nobody else has is ceremony. When a column actually
 * changes, that is the moment to add one.
 */
function migrate(db: Database) {
  db.run(`
    CREATE TABLE IF NOT EXISTS chats (
      id          TEXT PRIMARY KEY,
      title       TEXT NOT NULL,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS messages (
      id       INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id  TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      role     TEXT NOT NULL,
      text     TEXT NOT NULL,
      at       INTEGER NOT NULL
    );

    -- Every read is "the messages of one chat, in order", so that is the index.
    CREATE INDEX IF NOT EXISTS messages_by_chat ON messages(chat_id, at);

    -- SERVICES, NOT TALENTS. A talent is something the agent can do; a service is somewhere
    -- that fills a role — a filler that takes orders, later perhaps a data provider. They were
    -- one table and one tab, which is why installing a filler looked like gaining the ability to
    -- fill. Registering a service is done BY HAND: the relationship is deliberate, not
    -- discovered, and an on-chain registry would later be a SOURCE for this table rather than a
    -- replacement for it.
    CREATE TABLE IF NOT EXISTS services (
      id             TEXT PRIMARY KEY,
      name           TEXT NOT NULL,
      role           TEXT NOT NULL,
      url            TEXT NOT NULL,
      registered_at  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS talents (
      id            TEXT PRIMARY KEY,
      name          TEXT NOT NULL,
      manifest      TEXT NOT NULL,
      prompt        TEXT,
      installed_at  INTEGER NOT NULL
    );
  `);
  // Foreign keys are off by default in SQLite, per connection.
  db.run('PRAGMA foreign_keys = ON');
}

let db: Database | null = null;

/** Open once, lazily. The directory is created rather than assumed. */
function open(): Database {
  if (db) return db;
  fs.mkdirSync(DIR, { recursive: true });
  db = new Database(FILE, { create: true });
  migrate(db);
  return db;
}

// ── Chats ────────────────────────────────────────────────────────────────────

export type Chat = { id: string; title: string; createdAt: number; updatedAt: number };

export type Message = {
  id: number;
  role: 'user' | 'model' | 'pipeline' | 'chain';
  text: string;
  at: number;
};

/** Newest first, because that is the order a list of conversations is read in. */
export function listChats(): Chat[] {
  return open().query(
    'SELECT id, title, created_at AS createdAt, updated_at AS updatedAt '
    + 'FROM chats ORDER BY updated_at DESC',
  ).all() as Chat[];
}

export function createChat(title: string): Chat {
  const now = Date.now();
  const id = crypto.randomUUID();
  open().run(
    'INSERT INTO chats (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)',
    [id, title, now, now],
  );
  return { id, title, createdAt: now, updatedAt: now };
}

export function getChat(id: string): Chat | null {
  return (open().query(
    'SELECT id, title, created_at AS createdAt, updated_at AS updatedAt FROM chats WHERE id = ?',
  ).get(id) as Chat | undefined) ?? null;
}

/**
 * Rename a conversation.
 *
 * `updated_at` is deliberately NOT touched. That column orders the chat list by activity, and
 * renaming is not activity — a chat renamed today should not jump to the top of a list sorted by
 * when it was last USED.
 */
export function renameChat(id: string, title: string) {
  open().run('UPDATE chats SET title = ? WHERE id = ?', [title, id]);
}

export function deleteChat(id: string) {
  open().run('DELETE FROM chats WHERE id = ?', [id]);
}

export function messages(chatId: string): Message[] {
  return open().query(
    'SELECT id, role, text, at FROM messages WHERE chat_id = ? ORDER BY at, id',
  ).all(chatId) as Message[];
}

/**
 * Append a message and touch the chat.
 *
 * BOTH, IN ONE PLACE. `updated_at` is what orders the chat list, so a message that did not touch
 * its chat would leave the conversation where it was — and the two writes have to agree.
 */
export function append(chatId: string, role: Message['role'], text: string): Message {
  const db = open();
  const at = Date.now();
  const res = db.run(
    'INSERT INTO messages (chat_id, role, text, at) VALUES (?, ?, ?, ?)',
    [chatId, role, text, at],
  );
  db.run('UPDATE chats SET updated_at = ? WHERE id = ?', [at, chatId]);
  return { id: Number(res.lastInsertRowid), role, text, at };
}

// ── Services ─────────────────────────────────────────────────────────────────

export type Service = {
  id: string;
  name: string;
  /** What it is FOR — `filler` today. A role, not a verb the agent gains. */
  role: string;
  url: string;
  registeredAt: number;
};

export function listServices(): Service[] {
  return open().query(
    'SELECT id, name, role, url, registered_at AS registeredAt FROM services ORDER BY registered_at',
  ).all() as Service[];
}

export function registerService(id: string, name: string, role: string, url: string) {
  open().run(
    'INSERT INTO services (id, name, role, url, registered_at) VALUES (?, ?, ?, ?, ?) '
    + 'ON CONFLICT(id) DO UPDATE SET name = excluded.name, role = excluded.role, url = excluded.url',
    [id, name, role, url, Date.now()],
  );
}

export function unregisterService(id: string) {
  open().run('DELETE FROM services WHERE id = ?', [id]);
}

// ── Talents ──────────────────────────────────────────────────────────────────

export type InstalledTalent = {
  id: string;
  name: string;
  manifest: unknown;
  prompt: string | null;
  installedAt: number;
};

export function listTalents(): InstalledTalent[] {
  const rows = open().query(
    'SELECT id, name, manifest, prompt, installed_at AS installedAt '
    + 'FROM talents ORDER BY installed_at',
  ).all() as (Omit<InstalledTalent, 'manifest'> & { manifest: string })[];
  // Parsed on the way out, so a caller never has to know it is stored as text. A row whose
  // manifest will not parse is SKIPPED rather than thrown: one corrupt record should not take
  // down the whole list, and the list is what the user sees.
  const out: InstalledTalent[] = [];
  for (const r of rows) {
    try {
      out.push({ ...r, manifest: JSON.parse(r.manifest) });
    } catch {
      // Deliberately silent here and reported by the caller if it matters: a talent that cannot
      // be read is a talent that is not installed, from the app's point of view.
    }
  }
  return out;
}

export function installTalent(id: string, name: string, manifest: unknown, prompt: string | null) {
  open().run(
    'INSERT INTO talents (id, name, manifest, prompt, installed_at) VALUES (?, ?, ?, ?, ?) '
    + 'ON CONFLICT(id) DO UPDATE SET name = excluded.name, manifest = excluded.manifest, '
    + 'prompt = excluded.prompt',
    [id, name, JSON.stringify(manifest), prompt, Date.now()],
  );
}

export function uninstallTalent(id: string) {
  open().run('DELETE FROM talents WHERE id = ?', [id]);
}

/** Where the file is, for the one place that reports it. */
export const dbPath = FILE;
