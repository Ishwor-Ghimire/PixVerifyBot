const logger = require('../utils/logger');

function runMigrations(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      telegram_user_id INTEGER PRIMARY KEY,
      username TEXT,
      first_name TEXT,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
      last_active_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
      is_admin INTEGER DEFAULT 0,
      credit_balance REAL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS generations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_user_id INTEGER NOT NULL,
      email TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      job_id TEXT,
      result_url TEXT,
      error_code TEXT,
      credits_used REAL DEFAULT 1,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
      completed_at TEXT,
      FOREIGN KEY (telegram_user_id) REFERENCES users(telegram_user_id)
    );

    CREATE TABLE IF NOT EXISTS purchases (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_user_id INTEGER NOT NULL,
      amount TEXT,
      credits_added REAL DEFAULT 0,
      payment_status TEXT DEFAULT 'pending',
      payment_provider TEXT,
      payment_reference TEXT,
      payment_method TEXT,
      unique_amount REAL,
      checkout_url TEXT,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
      completed_at TEXT,
      FOREIGN KEY (telegram_user_id) REFERENCES users(telegram_user_id)
    );

    CREATE INDEX IF NOT EXISTS idx_generations_user ON generations(telegram_user_id);
    CREATE INDEX IF NOT EXISTS idx_generations_status ON generations(status);
    CREATE INDEX IF NOT EXISTS idx_purchases_user ON purchases(telegram_user_id);
    CREATE INDEX IF NOT EXISTS idx_purchases_status ON purchases(payment_status);
  `);

  // Migrate any old-format timestamps (YYYY-MM-DD HH:MM:SS) to ISO 8601 UTC (YYYY-MM-DDTHH:MM:SSZ)
  // Old rows used datetime('now') which stored without timezone marker.
  // New rows use strftime('%Y-%m-%dT%H:%M:%SZ','now').
  const tables = ['users', 'generations', 'purchases'];
  const timestampCols = {
    users: ['created_at', 'last_active_at'],
    generations: ['created_at', 'completed_at'],
    purchases: ['created_at', 'completed_at'],
  };
  for (const table of tables) {
    for (const col of timestampCols[table]) {
      db.prepare(
        `UPDATE ${table}
         SET ${col} = REPLACE(${col}, ' ', 'T') || 'Z'
         WHERE ${col} IS NOT NULL
           AND ${col} NOT LIKE '%Z'
           AND ${col} NOT LIKE '%T%'`
      ).run();
    }
  }

  // Migration: add password & totp_secret columns to generations (for storing on success)
  const genCols = db.prepare("PRAGMA table_info(generations)").all().map(c => c.name);
  if (!genCols.includes('password')) {
    db.exec('ALTER TABLE generations ADD COLUMN password TEXT');
  }
  if (!genCols.includes('totp_secret')) {
    db.exec('ALTER TABLE generations ADD COLUMN totp_secret TEXT');
  }

  logger.info('Database migrations completed');
}

module.exports = { runMigrations };
