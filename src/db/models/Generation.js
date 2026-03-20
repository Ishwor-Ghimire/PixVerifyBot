const { getDb } = require('../database');

const Generation = {
  create({ telegramUserId, email, password, totpSecret, creditsUsed = 1 }) {
    const result = getDb().prepare(
      `INSERT INTO generations (telegram_user_id, email, password, totp_secret, credits_used, status)
       VALUES (?, ?, ?, ?, ?, 'pending')`
    ).run(telegramUserId, email, password || null, totpSecret || null, creditsUsed);
    return result.lastInsertRowid;
  },

  updateStatus(id, { status, jobId, resultUrl, errorCode }) {
    const fields = ['status = ?'];
    const values = [status];

    if (jobId !== undefined) { fields.push('job_id = ?'); values.push(jobId); }
    if (resultUrl !== undefined) { fields.push('result_url = ?'); values.push(resultUrl); }
    if (errorCode !== undefined) { fields.push('error_code = ?'); values.push(errorCode); }
    if (status === 'success' || status === 'failed') {
      fields.push("completed_at = datetime('now')");
    }

    values.push(id);
    return getDb().prepare(
      `UPDATE generations SET ${fields.join(', ')} WHERE id = ?`
    ).run(...values);
  },

  getByUser(telegramUserId, limit = 5, offset = 0) {
    return getDb().prepare(
      'SELECT * FROM generations WHERE telegram_user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?'
    ).all(telegramUserId, limit, offset);
  },

  getCount(telegramUserId) {
    const row = getDb().prepare(
      'SELECT COUNT(*) as count FROM generations WHERE telegram_user_id = ?'
    ).get(telegramUserId);
    return row.count;
  },

  /**
   * Check if user has an active (pending/queued/running) generation
   */
  hasActive(telegramUserId) {
    const row = getDb().prepare(
      `SELECT COUNT(*) as count FROM generations
       WHERE telegram_user_id = ? AND status IN ('pending', 'queued', 'running')`
    ).get(telegramUserId);
    return row.count > 0;
  },

  getById(id) {
    return getDb().prepare('SELECT * FROM generations WHERE id = ?').get(id);
  },
};

module.exports = Generation;
