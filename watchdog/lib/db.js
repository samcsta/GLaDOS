const Database = require('better-sqlite3');
const fs = require('node:fs');
const path = require('node:path');
const { WATCHDOG_DB } = require('./config');

fs.mkdirSync(path.dirname(WATCHDOG_DB), { recursive: true });
const db = new Database(WATCHDOG_DB);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS target_health (
    target_url TEXT PRIMARY KEY,
    last_probed_at INTEGER,
    last_status INTEGER,
    consecutive_failures INTEGER DEFAULT 0,
    state TEXT NOT NULL DEFAULT 'unknown',
    reason TEXT,
    updated_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS halt_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id TEXT,
    engagement_id TEXT,
    reason TEXT,
    initiator TEXT,
    action TEXT NOT NULL,
    at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS breaker_trips (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    target_host TEXT NOT NULL,
    tripped_at INTEGER NOT NULL,
    sample_count INTEGER,
    last_status INTEGER
  );
`);

module.exports = { db };
