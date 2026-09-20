// Uses Node's built-in `node:sqlite` (available unflagged in Node >= 23.4,
// stable in Node 24). This avoids the native `sqlite3` package entirely, so
// there are no prebuilt-binary / glibc / build-toolchain issues on deploy.
const { DatabaseSync } = require("node:sqlite");
const path = require("path");
const fs = require("fs");

const dbPath = path.join(__dirname, "data", "menu.db");

// Ensure the data directory exists (the native sqlite3 package created the
// file but not the parent dir; be explicit so fresh checkouts just work).
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const db = new DatabaseSync(dbPath);

// Create tables (idempotent). node:sqlite is synchronous, so this all runs
// inline at module load — no callbacks / serialize() needed.
db.exec(`
CREATE TABLE IF NOT EXISTS brands (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    type TEXT DEFAULT 'juice'
);

CREATE TABLE IF NOT EXISTS juices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    brand_id INTEGER NOT NULL,
    flavor TEXT NOT NULL,
    mg INTEGER NOT NULL,
    type TEXT DEFAULT 'juice',
    active INTEGER DEFAULT 1,
    stock INTEGER DEFAULT 0,
    barcode TEXT,
    ordered INTEGER DEFAULT 0,
    FOREIGN KEY (brand_id) REFERENCES brands (id)
);

CREATE TABLE IF NOT EXISTS sales (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    juice_id INTEGER NOT NULL,
    barcode TEXT,
    sold_at TEXT NOT NULL,
    sold_date TEXT NOT NULL,
    voided INTEGER DEFAULT 0,
    FOREIGN KEY (juice_id) REFERENCES juices (id)
);

CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
`);

// Seed default settings (no-op if they already exist)
db.exec(`
INSERT OR IGNORE INTO settings (key, value) VALUES ('reorder_threshold', '2');
INSERT OR IGNORE INTO settings (key, value) VALUES ('disposable_mg', '50');
`);

// Migration: add columns to databases created before they existed
function ensureColumn(table, column, definition) {
  const cols = db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .map((r) => r.name);
  if (!cols.includes(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}
ensureColumn("juices", "stock", "INTEGER DEFAULT 0");
ensureColumn("juices", "barcode", "TEXT");
ensureColumn("juices", "type", "TEXT DEFAULT 'juice'");
ensureColumn("juices", "ordered", "INTEGER DEFAULT 0");
ensureColumn("brands", "type", "TEXT DEFAULT 'juice'");

// Promise-compatible helpers (server.js `await`s these; awaiting a plain
// value is a no-op, so the synchronous results pass straight through).
const dbHelpers = {
  all: (sql, params = []) => db.prepare(sql).all(...params),
  get: (sql, params = []) => db.prepare(sql).get(...params),
  run: (sql, params = []) => {
    const r = db.prepare(sql).run(...params);
    return { id: Number(r.lastInsertRowid), changes: Number(r.changes) };
  },
};

module.exports = dbHelpers;
