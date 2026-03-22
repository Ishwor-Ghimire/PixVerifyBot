const { getDb } = require('../db/database');
const User = require('../db/models/User');
const logger = require('../utils/logger');

const CreditService = {
  /**
   * Atomically reserve credits. Returns true if successful.
   * Uses a transaction to prevent race conditions.
   */
  reserveCredits(telegramUserId, amount = 1) {
    const db = getDb();
    const txn = db.transaction(() => {
      const user = User.findById(telegramUserId);
      if (!user || user.credit_balance < amount) {
        return false;
      }
      User.updateBalance(telegramUserId, -amount);
      return true;
    });

    const result = txn();
    logger.info('Credit reservation', { telegramUserId, amount, success: result });
    return result;
  },

  /**
   * Refund credits (e.g., on job failure)
   */
  refundCredits(telegramUserId, amount = 1) {
    User.updateBalance(telegramUserId, amount);
    logger.info('Credit refund', { telegramUserId, amount });
  },

  /**
   * Get current balance
   */
  getBalance(telegramUserId) {
    return User.getBalance(telegramUserId);
  },

  /**
   * Add credits (e.g., after purchase confirmation)
   */
  addCredits(telegramUserId, amount) {
    User.updateBalance(telegramUserId, amount);
    logger.info('Credits added', { telegramUserId, amount });
  },

  /**
   * Remove credits from a user (admin action).
   * Returns true if successful, false if insufficient balance.
   */
  removeCredits(telegramUserId, amount) {
    const db = getDb();
    const txn = db.transaction(() => {
      const user = User.findById(telegramUserId);
      if (!user || user.credit_balance < amount) {
        return false;
      }
      User.updateBalance(telegramUserId, -amount);
      return true;
    });

    const result = txn();
    logger.info('Credits removed', { telegramUserId, amount, success: result });
    return result;
  },
};

module.exports = CreditService;
