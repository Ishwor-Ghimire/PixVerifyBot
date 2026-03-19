const logger = require('../utils/logger');

function runMigrations(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      telegram_user_id INTEGER PRIMARY KEY,
      username TEXT,
      first_name TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      last_active_at TEXT DEFAULT (datetime('now')),
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
      created_at TEXT DEFAULT (datetime('now')),
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
      created_at TEXT DEFAULT (datetime('now')),
      completed_at TEXT,
      FOREIGN KEY (telegram_user_id) REFERENCES users(telegram_user_id)
    );

    CREATE INDEX IF NOT EXISTS idx_generations_user ON generations(telegram_user_id);
    CREATE INDEX IF NOT EXISTS idx_generations_status ON generations(status);
    CREATE INDEX IF NOT EXISTS idx_purchases_user ON purchases(telegram_user_id);
    CREATE INDEX IF NOT EXISTS idx_purchases_status ON purchases(payment_status);
  `);

  logger.info('Database migrations completed');
}

module.exports = { runMigrations };
