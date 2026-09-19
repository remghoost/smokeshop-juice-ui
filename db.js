const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.join(__dirname, 'data', 'menu.db');
const db = new sqlite3.Database(dbPath);

db.serialize(() => {
    // Brands table (type = 'juice' or 'disposable' — separate brand pools)
    db.run(`CREATE TABLE IF NOT EXISTS brands (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE NOT NULL,
        type TEXT DEFAULT 'juice'
    )`);

    // Juices table (type = 'juice' or 'disposable')
    db.run(`CREATE TABLE IF NOT EXISTS juices (
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
    )`);

    // Sales log table (one row per barcode-scan sale; voided = undone)
    // sold_at = ISO timestamp (UTC); sold_date = local YYYY-MM-DD for easy daily grouping
    db.run(`CREATE TABLE IF NOT EXISTS sales (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        juice_id INTEGER NOT NULL,
        barcode TEXT,
        sold_at TEXT NOT NULL,
        sold_date TEXT NOT NULL,
        voided INTEGER DEFAULT 0,
        FOREIGN KEY (juice_id) REFERENCES juices (id)
    )`);

    // Settings table (key/value) for tunable options like the reorder threshold
    db.run(`CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
    )`);

    // Seed the default reorder threshold (reorder when stock is at or below this)
    db.run(`INSERT OR IGNORE INTO settings (key, value) VALUES ('reorder_threshold', '2')`);

    // Seed the fixed nicotine strength for disposables (all disposables share one mg)
    db.run(`INSERT OR IGNORE INTO settings (key, value) VALUES ('disposable_mg', '50')`);

    // Migration: add columns to databases created before they existed
    db.all("PRAGMA table_info(juices)", (err, rows) => {
        if (!err) {
            const cols = rows.map((r) => r.name);
            if (!cols.includes("stock")) {
                db.run("ALTER TABLE juices ADD COLUMN stock INTEGER DEFAULT 0");
            }
            if (!cols.includes("barcode")) {
                db.run("ALTER TABLE juices ADD COLUMN barcode TEXT");
            }
            if (!cols.includes("type")) {
                db.run("ALTER TABLE juices ADD COLUMN type TEXT DEFAULT 'juice'");
            }
            if (!cols.includes("ordered")) {
                db.run("ALTER TABLE juices ADD COLUMN ordered INTEGER DEFAULT 0");
            }
        }
    });

    db.all("PRAGMA table_info(brands)", (err, rows) => {
        if (!err) {
            const cols = rows.map((r) => r.name);
            if (!cols.includes("type")) {
                db.run("ALTER TABLE brands ADD COLUMN type TEXT DEFAULT 'juice'");
            }
        }
    });
});

const dbHelpers = {
    all: (sql, params = []) => {
        return new Promise((resolve, reject) => {
            db.all(sql, params, (err, rows) => {
                if (err) reject(err);
                else resolve(rows);
            });
        });
    },
    get: (sql, params = []) => {
        return new Promise((resolve, reject) => {
            db.get(sql, params, (err, row) => {
                if (err) reject(err);
                else resolve(row);
            });
        });
    },
    run: (sql, params = []) => {
        return new Promise((resolve, reject) => {
            db.run(sql, params, function(err) {
                if (err) reject(err);
                else resolve({ id: this.lastID, changes: this.changes });
            });
        });
    }
};

module.exports = dbHelpers;
