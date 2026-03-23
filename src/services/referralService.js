const Referral = require('../db/models/Referral');
const Purchase = require('../db/models/Purchase');
const User = require('../db/models/User');
const { getDb } = require('../db/database');
const config = require('../config');
const logger = require('../utils/logger');

const ReferralService = {
  /**
   * Record a referral when a new user joins via a referral link.
   * Validates: no self-referral, referred user not already referred, referrer exists.
   * Returns { success, reason? }
   */
  recordReferral(referrerUserId, referredUserId) {
    // Prevent self-referral
    if (referrerUserId === referredUserId) {
      logger.warn('Self-referral attempt blocked', { referrerUserId });
      return { success: false, reason: 'self_referral' };
    }

    // Check referrer exists
    const referrer = User.findById(referrerUserId);
    if (!referrer) {
      logger.warn('Referral from non-existent user', { referrerUserId });
      return { success: false, reason: 'referrer_not_found' };
    }

    // Check if referred user is already referred by someone
    const existing = Referral.findByReferredUser(referredUserId);
    if (existing) {
      logger.info('User already referred', { referredUserId, existingReferrer: existing.referrer_user_id });
      return { success: false, reason: 'already_referred' };
    }

    try {
      Referral.create(referrerUserId, referredUserId);
      // Also set referred_by on the user row
      getDb().prepare(
        'UPDATE users SET referred_by = ? WHERE telegram_user_id = ?'
      ).run(referrerUserId, referredUserId);

      logger.info('Referral recorded', { referrerUserId, referredUserId });
      return { success: true };
    } catch (err) {
      // UNIQUE constraint violation = already referred
      if (err.message.includes('UNIQUE')) {
        return { success: false, reason: 'already_referred' };
      }
      logger.error('Failed to record referral', { error: err.message });
      return { success: false, reason: 'error' };
    }
  },

  /**
   * After a payment is confirmed, check if the referred user has met
   * the minimum top-up threshold. If so, reward the referrer.
   */
  checkAndRewardReferral(referredUserId) {
    const referral = Referral.findByReferredUser(referredUserId);
    if (!referral || referral.status === 'completed') {
      return; // No referral or already rewarded
    }

    // Sum all completed purchases for this user
    const row = getDb().prepare(
      `SELECT COALESCE(SUM(credits_added), 0) as total_credits
       FROM purchases
       WHERE telegram_user_id = ? AND payment_status = 'completed'`
    ).get(referredUserId);

    const totalCredits = row.total_credits || 0;
    if (totalCredits < config.referral.minTopUpCredits) {
      return; // Hasn't met threshold yet
    }

    // Award referral reward atomically
    const db = getDb();
    const txn = db.transaction(() => {
      // Double-check inside transaction
      const ref = Referral.findByReferredUser(referredUserId);
      if (!ref || ref.status === 'completed') return false;

      Referral.markCompleted(referredUserId);
      User.updateBalance(ref.referrer_user_id, config.referral.rewardCredits);
      return ref.referrer_user_id;
    });

    const referrerId = txn();
    if (referrerId) {
      logger.info('Referral reward credited', {
        referrerUserId: referrerId,
        referredUserId,
        reward: config.referral.rewardCredits,
      });
    }

    return referrerId; // Return referrer ID so caller can notify them
  },

  /**
   * Get referral stats for a user.
   */
  getReferralStats(referrerUserId) {
    const stats = Referral.getStats(referrerUserId);
    return {
      ...stats,
      totalRewards: (stats.rewarded * config.referral.rewardCredits).toFixed(2),
      rewardPerReferral: config.referral.rewardCredits,
    };
  },

  /**
   * Generate referral link for a user.
   */
  getReferralLink(botUsername, userId) {
    return `https://t.me/${botUsername}?start=ref_${userId}`;
  },

  /**
   * Parse referral code from deep-link payload.
   * Returns referrer user ID or null.
   */
  parseReferralCode(payload) {
    if (!payload) return null;
    const match = payload.match(/^ref_(\d+)$/);
    return match ? Number(match[1]) : null;
  },
};

module.exports = ReferralService;
