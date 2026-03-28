const { getDb } = require('../db/database');
const config = require('../config');
const logger = require('../utils/logger');

const META_KEY = 'shadow_ban_ids';

/** @type {Set<number>} */
const bannedUsers = new Set();

const ShadowBanService = {
  /**
   * Initialize — merge .env seed list with DB-persisted list.
   * Call once after database is initialized.
   */
  init() {
    // Seed from .env
    for (const id of config.shadowBan.userIds) {
      bannedUsers.add(id);
    }

    // Load persisted bans from DB
    try {
      const db = getDb();
      const row = db.prepare('SELECT value FROM app_meta WHERE key = ?').get(META_KEY);
      if (row && row.value) {
        const ids = JSON.parse(row.value);
        for (const id of ids) {
          bannedUsers.add(id);
        }
      }
    } catch (err) {
      logger.warn('Failed to load shadow ban list from DB', { error: err.message });
    }

    logger.info('ShadowBanService initialized', { count: bannedUsers.size });
  },

  /**
   * Check if a user is shadow banned
   */
  isBanned(userId) {
    return bannedUsers.has(Number(userId));
  },

  /**
   * Shadow ban a user
   * @returns {boolean} true if newly banned, false if already banned
   */
  ban(userId) {
    const id = Number(userId);
    if (bannedUsers.has(id)) return false;
    bannedUsers.add(id);
    this._persist();
    logger.info('User shadow banned', { userId: id });
    return true;
  },

  /**
   * Remove shadow ban from a user
   * @returns {boolean} true if unbanned, false if wasn't banned
   */
  unban(userId) {
    const id = Number(userId);
    if (!bannedUsers.has(id)) return false;
    bannedUsers.delete(id);
    this._persist();
    logger.info('User shadow unbanned', { userId: id });
    return true;
  },

  /**
   * Get all shadow banned user IDs
   */
  getAll() {
    return [...bannedUsers];
  },

  /** @private Persist current set to DB */
  _persist() {
    try {
      const db = getDb();
      db.prepare(
        `INSERT INTO app_meta (key, value, updated_at)
         VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%SZ','now'))
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
      ).run(META_KEY, JSON.stringify([...bannedUsers]));
    } catch (err) {
      logger.error('Failed to persist shadow ban list', { error: err.message });
    }
  },
};

module.exports = ShadowBanService;
