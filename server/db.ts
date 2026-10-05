import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Session, Item } from "./model";
import { telemetryTables } from "./telemetry/events";
import { authTables } from "./auth";
import { frictionTables } from "./friction";

export type SessionRow = Omit<Session, "items"> & {
  id: number;
  host: string;
  snapshot: string;
  snapshotTime: number;
  itemCount: number;
};
export type ItemRow = Omit<Item, "pointer"> & {
  id: number;
  seq: number;
  sessionId: number;
  pointer: string;
};
export function openIndex(path: string, busyTimeout = 5000) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { strict: true });
  db.run(
    `PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=${busyTimeout};`,
  );
  db.run(`
    CREATE TABLE IF NOT EXISTS setting(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS snapshot(path TEXT PRIMARY KEY,manifest TEXT NOT NULL,signature TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS file_cache(signature TEXT PRIMARY KEY,payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS native_overlay(host TEXT NOT NULL,client TEXT NOT NULL,nativeId TEXT NOT NULL,title TEXT NOT NULL,branch TEXT NOT NULL,threadId TEXT NOT NULL,snapshotTime INTEGER NOT NULL,PRIMARY KEY(host,client,nativeId));
    CREATE TABLE IF NOT EXISTS session(
      id INTEGER PRIMARY KEY, host TEXT NOT NULL, client TEXT NOT NULL, nativeId TEXT NOT NULL,
      title TEXT NOT NULL, cwd TEXT NOT NULL, repo TEXT NOT NULL, branch TEXT NOT NULL, model TEXT NOT NULL, provider TEXT NOT NULL,
      started INTEGER NOT NULL, updated INTEGER NOT NULL, tokens INTEGER NOT NULL, parentId TEXT NOT NULL, kind TEXT NOT NULL,
      t3ThreadId TEXT NOT NULL, snapshot TEXT NOT NULL, snapshotTime INTEGER NOT NULL, itemCount INTEGER NOT NULL,
      UNIQUE(host,client,nativeId));
    CREATE TABLE IF NOT EXISTS item(
      id INTEGER PRIMARY KEY,sessionId INTEGER NOT NULL REFERENCES session(id) ON DELETE CASCADE,seq INTEGER NOT NULL,
      time INTEGER NOT NULL,role TEXT NOT NULL,tool TEXT NOT NULL,callId TEXT NOT NULL,body TEXT NOT NULL,bodyLength INTEGER NOT NULL,pointer TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS item_session ON item(sessionId,seq);
    CREATE INDEX IF NOT EXISTS session_time ON session(updated DESC);
    CREATE INDEX IF NOT EXISTS session_native_id ON session(nativeId);
    CREATE INDEX IF NOT EXISTS session_t3_thread_id ON session(t3ThreadId);
    CREATE VIRTUAL TABLE IF NOT EXISTS session_fts USING fts5(title,cwd,repo,branch,model,content='session',content_rowid='id');
    CREATE VIRTUAL TABLE IF NOT EXISTS item_fts USING fts5(body,tool,content='item',content_rowid='id');
    CREATE TRIGGER IF NOT EXISTS session_ai AFTER INSERT ON session BEGIN
      INSERT INTO session_fts(rowid,title,cwd,repo,branch,model) VALUES(new.id,new.title,new.cwd,new.repo,new.branch,new.model); END;
    CREATE TRIGGER IF NOT EXISTS session_ad AFTER DELETE ON session BEGIN
      INSERT INTO session_fts(session_fts,rowid,title,cwd,repo,branch,model) VALUES('delete',old.id,old.title,old.cwd,old.repo,old.branch,old.model); END;
    CREATE TRIGGER IF NOT EXISTS session_au AFTER UPDATE ON session BEGIN
      INSERT INTO session_fts(session_fts,rowid,title,cwd,repo,branch,model) VALUES('delete',old.id,old.title,old.cwd,old.repo,old.branch,old.model);
      INSERT INTO session_fts(rowid,title,cwd,repo,branch,model) VALUES(new.id,new.title,new.cwd,new.repo,new.branch,new.model); END;
    CREATE TRIGGER IF NOT EXISTS item_ai AFTER INSERT ON item BEGIN INSERT INTO item_fts(rowid,body,tool) VALUES(new.id,new.body,new.tool); END;
    CREATE TRIGGER IF NOT EXISTS item_ad AFTER DELETE ON item BEGIN INSERT INTO item_fts(item_fts,rowid,body,tool) VALUES('delete',old.id,old.body,old.tool); END;
  `);
  telemetryTables(db);
  authTables(db);
  frictionTables(db);
  return db;
}
export function pruneEvents(db: Database, now = Date.now()) {
  const cutoff = now - 8 * 86400000;
  db.transaction(() => {
    for (const table of [
      "usage_event",
      "error_event",
      "auth_state_event",
      "dashboard_event",
      "friction_event",
    ])
      db.query(`DELETE FROM ${table} WHERE time<?`).run(cutoff);
  })();
}
