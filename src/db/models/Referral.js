const { getDb } = require('../database');

const Referral = {
  /**
   * Create a pending referral record.
   */
  create(referrerUserId, referredUserId) {
    return getDb().prepare(
      `INSERT INTO referrals (referrer_user_id, referred_user_id, status)
       VALUES (?, ?, 'pending')`
    ).run(referrerUserId, referredUserId);
  },

  /**
   * Check if a user was already referred by someone.
   */
  findByReferredUser(referredUserId) {
    return getDb().prepare(
      'SELECT * FROM referrals WHERE referred_user_id = ?'
    ).get(referredUserId);
  },

  /**
   * Get all referrals made by a referrer.
   */
  findByReferrer(referrerUserId) {
    return getDb().prepare(
      'SELECT * FROM referrals WHERE referrer_user_id = ? ORDER BY created_at DESC'
    ).all(referrerUserId);
  },

  /**
   * Mark a referral as completed and flag reward as credited.
   */
  markCompleted(referredUserId) {
    return getDb().prepare(
      `UPDATE referrals
       SET status = 'completed',
           reward_credited = 1,
           completed_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
       WHERE referred_user_id = ? AND status = 'pending'`
    ).run(referredUserId);
  },

  /**
   * Get referral stats for a user.
   */
  getStats(referrerUserId) {
    const row = getDb().prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as successful,
        SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
        SUM(CASE WHEN reward_credited = 1 THEN 1 ELSE 0 END) as rewarded
      FROM referrals
      WHERE referrer_user_id = ?
    `).get(referrerUserId);

    return {
      total: row.total || 0,
      successful: row.successful || 0,
      pending: row.pending || 0,
      rewarded: row.rewarded || 0,
    };
  },
};

module.exports = Referral;
