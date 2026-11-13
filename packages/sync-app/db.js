import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- 每个集合一行的同步状态
CREATE TABLE IF NOT EXISTS sync_state (
  collection        TEXT PRIMARY KEY,
  enabled           INTEGER NOT NULL DEFAULT 0,
  active_round_id   INTEGER,
  delta_link        TEXT,
  last_round_id     INTEGER,
  last_error        TEXT,
  auto_suppressed   INTEGER NOT NULL DEFAULT 0,  -- 取消重建后置 1：抑制自动轮询，仅手动重试
  updated_at        TEXT NOT NULL
);

-- 同步轮次（全量 / 增量 / 重建）
CREATE TABLE IF NOT EXISTS sync_rounds (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  collection        TEXT NOT NULL,
  kind              TEXT NOT NULL,              -- full | delta | rebuild
  status            TEXT NOT NULL,              -- running | completed | failed | cancelled
  cursor            TEXT,                       -- 下一次请求使用的链接（首页为集合入口）
  final_delta_link  TEXT,
  pages_fetched     INTEGER NOT NULL DEFAULT 0,
  items_added       INTEGER NOT NULL DEFAULT 0,
  items_updated     INTEGER NOT NULL DEFAULT 0,
  items_deleted     INTEGER NOT NULL DEFAULT 0,
  dupe_pages        INTEGER NOT NULL DEFAULT 0,
  dupe_items        INTEGER NOT NULL DEFAULT 0,
  stale_events      INTEGER NOT NULL DEFAULT 0,
  cancel_requested  INTEGER NOT NULL DEFAULT 0,
  error_code        TEXT,
  error             TEXT,
  started_at        TEXT NOT NULL,
  completed_at      TEXT
);
CREATE INDEX IF NOT EXISTS idx_rounds_collection ON sync_rounds(collection, id);

-- 页面台账：同一轮次内按 pageId 去重，重复页只处理一次
CREATE TABLE IF NOT EXISTS sync_pages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  round_id    INTEGER NOT NULL,
  collection  TEXT NOT NULL,
  page_no     INTEGER NOT NULL,
  page_id     TEXT NOT NULL,
  item_count  INTEGER NOT NULL,
  is_replay   INTEGER NOT NULL DEFAULT 0,
  fetched_at  TEXT NOT NULL,
  UNIQUE(round_id, page_id)
);

-- 生效中的实体（含逻辑删除与孤儿标记）
CREATE TABLE IF NOT EXISTS entities (
  collection      TEXT NOT NULL,
  entity_key      INTEGER NOT NULL,
  data_json       TEXT,
  status          TEXT NOT NULL DEFAULT 'active',  -- active | orphan | tombstoned
  orphan_reason   TEXT,
  source_seq      INTEGER NOT NULL DEFAULT 0,
  first_round_id  INTEGER,
  last_round_id   INTEGER,
  updated_at      TEXT NOT NULL,
  PRIMARY KEY (collection, entity_key)
);
CREATE INDEX IF NOT EXISTS idx_entities_status ON entities(collection, status);

-- 溯源：一条记录的新增/更新/删除/跳过分别来自哪一轮、第几个请求
CREATE TABLE IF NOT EXISTS entity_provenance (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  collection   TEXT NOT NULL,
  entity_key   INTEGER NOT NULL,
  round_id     INTEGER NOT NULL,
  request_no   INTEGER NOT NULL,
  op           TEXT NOT NULL,   -- created | updated | deleted | stale_skipped | orphan_staged | orphan_adopted | delete_repeated
  source_seq   INTEGER,
  detail       TEXT,
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_prov_entity ON entity_provenance(collection, entity_key, id);

-- 重建隔离区：未完整收齐前绝不接触 entities 生效表
CREATE TABLE IF NOT EXISTS staging_entities (
  round_id    INTEGER NOT NULL,
  collection  TEXT NOT NULL,
  entity_key  INTEGER NOT NULL,
  data_json   TEXT NOT NULL,
  source_seq  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (round_id, collection, entity_key)
);
`;

export function openDb(dbPath) {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

// 轻量幂等迁移：为旧版本库补齐后加的列
function migrate(db) {
  const cols = db.prepare('PRAGMA table_info(sync_state)').all().map((c) => c.name);
  if (!cols.includes('auto_suppressed')) {
    db.exec('ALTER TABLE sync_state ADD COLUMN auto_suppressed INTEGER NOT NULL DEFAULT 0');
  }
}

export const now = () => new Date().toISOString();

export function ensureState(db, collection) {
  db.prepare(
    `INSERT INTO sync_state (collection, enabled, updated_at)
     VALUES (?, 0, ?)
     ON CONFLICT(collection) DO NOTHING`
  ).run(collection, now());
}
