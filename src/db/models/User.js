const { getDb } = require('../database');
const config = require('../../config');

const User = {
  /**
   * Find user or create if first interaction.
   * Returns the user row.
   */
  findOrCreate(telegramUser) {
    const db = getDb();
    const existing = db.prepare(
      'SELECT * FROM users WHERE telegram_user_id = ?'
    ).get(telegramUser.id);

    if (existing) {
      db.prepare(
        'UPDATE users SET last_active_at = datetime(\'now\'), username = ?, first_name = ? WHERE telegram_user_id = ?'
      ).run(telegramUser.username || null, telegramUser.first_name || null, telegramUser.id);
      return { ...existing, isNew: false };
    }

    const isAdmin = config.admin.userIds.includes(telegramUser.id) ? 1 : 0;
    db.prepare(
      `INSERT INTO users (telegram_user_id, username, first_name, is_admin, credit_balance)
       VALUES (?, ?, ?, ?, ?)`
    ).run(
      telegramUser.id,
      telegramUser.username || null,
      telegramUser.first_name || null,
      isAdmin,
      config.credits.defaultBalance
    );

    const user = db.prepare(
      'SELECT * FROM users WHERE telegram_user_id = ?'
    ).get(telegramUser.id);

    return { ...user, isNew: true };
  },

  findById(telegramUserId) {
    return getDb().prepare(
      'SELECT * FROM users WHERE telegram_user_id = ?'
    ).get(telegramUserId);
  },

  updateBalance(telegramUserId, delta) {
    return getDb().prepare(
      'UPDATE users SET credit_balance = credit_balance + ? WHERE telegram_user_id = ?'
    ).run(delta, telegramUserId);
  },

  getBalance(telegramUserId) {
    const row = getDb().prepare(
      'SELECT credit_balance FROM users WHERE telegram_user_id = ?'
    ).get(telegramUserId);
    return row ? row.credit_balance : 0;
  },

  setLastActive(telegramUserId) {
    return getDb().prepare(
      'UPDATE users SET last_active_at = datetime(\'now\') WHERE telegram_user_id = ?'
    ).run(telegramUserId);
  },

  isAdmin(telegramUserId) {
    const user = getDb().prepare(
      'SELECT is_admin FROM users WHERE telegram_user_id = ?'
    ).get(telegramUserId);
    return (user && user.is_admin === 1) || config.admin.userIds.includes(telegramUserId);
  },
};

module.exports = User;
