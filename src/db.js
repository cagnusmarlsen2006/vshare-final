'use strict';

/**
 * SQLite persistence (better-sqlite3, WAL mode). The database file is created on
 * first run. All state transitions that matter for security are single SQL
 * statements so they are atomic even under concurrent requests.
 */
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS files (
  id                  TEXT PRIMARY KEY,           -- public share id (nanoid 21)
  storage_id          TEXT NOT NULL UNIQUE,       -- storage object id (nanoid 21)
  original_name       TEXT NOT NULL,              -- sanitised, metadata only
  mime_type           TEXT NOT NULL,
  size                INTEGER NOT NULL DEFAULT 0, -- plaintext bytes
  status              TEXT NOT NULL CHECK (status IN ('pending','active','deleted')),
  created_at          INTEGER NOT NULL,           -- epoch ms
  expires_at          INTEGER NOT NULL,           -- epoch ms
  max_downloads       INTEGER,                    -- NULL = no download limit
  downloads           INTEGER NOT NULL DEFAULT 0, -- claimed (incl. in-flight)
  completed_downloads INTEGER NOT NULL DEFAULT 0, -- finished successfully
  password_hash       TEXT,                       -- scrypt$salt$hash or NULL
  failed_attempts     INTEGER NOT NULL DEFAULT 0,
  locked_until        INTEGER,                    -- epoch ms or NULL
  delete_token_hash   TEXT NOT NULL,              -- sha256 hex of the delete token
  wrapped_key         BLOB NOT NULL,              -- data key wrapped by MASTER_KEY (ct||tag)
  wrap_iv             BLOB NOT NULL,
  data_iv             BLOB NOT NULL,
  auth_tag            BLOB                        -- set when the upload completes
);
CREATE INDEX IF NOT EXISTS idx_files_status_expires ON files (status, expires_at);

-- Context-based sharing: access keys reserved by faculty before uploading.
CREATE TABLE IF NOT EXISTS access_keys (
  key_hash    TEXT PRIMARY KEY,                   -- sha256 hex of the access key
  campus      TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,                   -- reservation expiry (unused keys)
  file_id     TEXT                                -- set once a file is bound to the key
);
`;

/** Columns added after v1. Applied idempotently so existing databases upgrade in place. */
const MIGRATIONS = [
  ['kind', "ALTER TABLE files ADD COLUMN kind TEXT NOT NULL DEFAULT 'share'"], // share|context|study|verified
  ['meta', 'ALTER TABLE files ADD COLUMN meta TEXT'], // JSON (campus, department, analysis summary…)
  ['access_key_hash', 'ALTER TABLE files ADD COLUMN access_key_hash TEXT'],
];

function migrate(db) {
  const cols = new Set(db.prepare('PRAGMA table_info(files)').all().map((c) => c.name));
  for (const [col, sql] of MIGRATIONS) if (!cols.has(col)) db.exec(sql);
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_files_access_key ON files (access_key_hash) WHERE access_key_hash IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_files_kind ON files (kind, status, created_at);
  `);
}

function openDatabase(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

/** Prepared-statement repository. `now` is always passed in (epoch ms) for testability. */
function createRepo(db) {
  const s = {
    insertPending: db.prepare(`
      INSERT INTO files (id, storage_id, original_name, mime_type, status, created_at, expires_at,
                         max_downloads, delete_token_hash, wrapped_key, wrap_iv, data_iv, kind, meta)
      VALUES (@id, @storage_id, @original_name, @mime_type, 'pending', @created_at, @expires_at,
              @max_downloads, @delete_token_hash, @wrapped_key, @wrap_iv, @data_iv, @kind, @meta)`),
    activate: db.prepare(`
      UPDATE files SET status = 'active', size = @size, auth_tag = @auth_tag,
                       password_hash = @password_hash, expires_at = @expires_at,
                       meta = @meta, access_key_hash = @access_key_hash
      WHERE id = @id AND status = 'pending'`),
    listStudy: db.prepare(`
      SELECT id, original_name, size, created_at, expires_at, meta FROM files
      WHERE kind = 'study' AND status = 'active' AND expires_at > @now
        AND json_extract(meta, '$.department') = @department AND json_extract(meta, '$.year') = @year
      ORDER BY created_at DESC LIMIT 200`),
    getByAccessKey: db.prepare('SELECT * FROM files WHERE access_key_hash = ?'),
    reserveKey: db.prepare(`
      INSERT INTO access_keys (key_hash, campus, created_at, expires_at) VALUES (@key_hash, @campus, @created_at, @expires_at)`),
    getReservation: db.prepare('SELECT * FROM access_keys WHERE key_hash = ?'),
    // Atomic: a key can be bound to exactly one file.
    bindReservation: db.prepare(`
      UPDATE access_keys SET file_id = @file_id
      WHERE key_hash = @key_hash AND campus = @campus AND file_id IS NULL AND expires_at > @now`),
    pruneReservations: db.prepare(`
      DELETE FROM access_keys
      WHERE (file_id IS NULL AND expires_at <= @now)
         OR (file_id IS NOT NULL AND file_id NOT IN (SELECT id FROM files))`),
    get: db.prepare('SELECT * FROM files WHERE id = ?'),
    deleteRow: db.prepare('DELETE FROM files WHERE id = ?'),
    markDeleted: db.prepare(`UPDATE files SET status = 'deleted' WHERE id = ?`),

    // THE atomic download claim. One statement: only succeeds while the file is
    // active, not expired, not locked and still has downloads left.
    claim: db.prepare(`
      UPDATE files SET downloads = downloads + 1
      WHERE id = @id
        AND status = 'active'
        AND expires_at > @now
        AND (locked_until IS NULL OR locked_until <= @now)
        AND (max_downloads IS NULL OR downloads < max_downloads)`),
    rollback: db.prepare(`
      UPDATE files SET downloads = downloads - 1 WHERE id = ? AND downloads > 0`),
    complete: db.prepare(`
      UPDATE files SET completed_downloads = completed_downloads + 1 WHERE id = ?
      RETURNING completed_downloads, max_downloads`),

    // Wrong password: increment; on the 5th consecutive failure lock and reset.
    // (In SQLite, expressions in SET see the row's OLD values.)
    registerFailure: db.prepare(`
      UPDATE files SET
        failed_attempts = CASE WHEN failed_attempts + 1 >= @max THEN 0 ELSE failed_attempts + 1 END,
        locked_until    = CASE WHEN failed_attempts + 1 >= @max THEN @lockUntil ELSE locked_until END
      WHERE id = @id
      RETURNING failed_attempts, locked_until`),
    resetFailures: db.prepare(`UPDATE files SET failed_attempts = 0 WHERE id = ? AND failed_attempts <> 0`),

    // Cleanup candidates.
    dueForCleanup: db.prepare(`
      SELECT id, storage_id, status FROM files
      WHERE status = 'deleted'
         OR status = 'pending'
         OR (status = 'active' AND expires_at <= @now)
         OR (status = 'active' AND max_downloads IS NOT NULL AND completed_downloads >= max_downloads)`),
  };

  return {
    insertPending: (row) => s.insertPending.run({ kind: 'share', meta: null, ...row }),
    activate: (row) => s.activate.run({ meta: null, access_key_hash: null, ...row }).changes === 1,
    listStudy: (department, year, now) => s.listStudy.all({ department, year, now }),
    getByAccessKey: (hash) => s.getByAccessKey.get(hash),
    reserveKey: (row) => s.reserveKey.run(row),
    getReservation: (hash) => s.getReservation.get(hash),
    bindReservation: (row) => s.bindReservation.run(row).changes === 1,
    pruneReservations: (now) => s.pruneReservations.run({ now }).changes,
    get: (id) => s.get.get(id),
    deleteRow: (id) => s.deleteRow.run(id).changes === 1,
    markDeleted: (id) => s.markDeleted.run(id).changes === 1,
    claim: (id, now) => s.claim.run({ id, now }).changes === 1,
    rollback: (id) => s.rollback.run(id).changes === 1,
    complete: (id) => s.complete.get(id),
    registerFailure: (id, max, lockUntil) => s.registerFailure.get({ id, max, lockUntil }),
    resetFailures: (id) => s.resetFailures.run(id),
    dueForCleanup: (now) => s.dueForCleanup.all({ now }),
  };
}

module.exports = { openDatabase, createRepo };
