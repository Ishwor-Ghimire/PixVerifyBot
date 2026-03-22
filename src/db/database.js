const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const config = require('../config');
const logger = require('../utils/logger');
const { runMigrations } = require('./migrations');

let db;

function getDb() {
  if (!db) {
    throw new Error('Database not initialized. Call initDatabase() first.');
  }
  return db;
}

function initDatabase() {
  const dbPath = path.resolve(config.db.path);
  const dbDir = path.dirname(dbPath);

  // Warn if running on Railway without a volume-backed path
  if (process.env.RAILWAY_ENVIRONMENT && !dbPath.startsWith('/data')) {
    logger.warn(
      'Running on Railway but DB_PATH does not point to a volume mount (/data). ' +
      'Data will be LOST on every deploy! Set DB_PATH=/data/pixverify.db and attach a volume at /data.',
    );
  }

  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  db = new Database(dbPath);

  // Performance optimizations
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = FULL');
  db.pragma('foreign_keys = ON');

  runMigrations(db);
  logger.info('Database initialized', { path: dbPath });

  return db;
}

function closeDatabase() {
  if (db) {
    try {
      // Checkpoint WAL to merge pending writes into the main DB file
      // This prevents data loss (e.g. credit balance) on hard restart
      db.pragma('wal_checkpoint(TRUNCATE)');
    } catch (err) {
      logger.error('WAL checkpoint failed', { error: err.message });
    }
    db.close();
    db = null;
    logger.info('Database connection closed');
  }
}

module.exports = { getDb, initDatabase, closeDatabase };
