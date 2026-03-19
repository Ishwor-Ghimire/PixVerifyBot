const { getDb } = require('../database');

function buildStatusUpdate({ paymentStatus, paymentReference }) {
  const fields = ['payment_status = ?'];
  const values = [paymentStatus];

  if (paymentReference !== undefined) {
    fields.push('payment_reference = ?');
    values.push(paymentReference);
  }
  if (['completed', 'failed', 'expired', 'rejected'].includes(paymentStatus)) {
    fields.push("completed_at = datetime('now')");
  }

  return { fields, values };
}

const Purchase = {
  create({ telegramUserId, amount, creditsAdded, paymentProvider = null, paymentMethod = null, uniqueAmount = null, checkoutUrl = null, paymentReference = null }) {
    const result = getDb().prepare(
      `INSERT INTO purchases (telegram_user_id, amount, credits_added, payment_provider, payment_status, payment_method, unique_amount, checkout_url, payment_reference)
       VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?)`
    ).run(telegramUserId, amount, creditsAdded, paymentProvider, paymentMethod, uniqueAmount, checkoutUrl, paymentReference);
    return result.lastInsertRowid;
  },

  updateStatus(id, { paymentStatus, paymentReference }) {
    const { fields, values } = buildStatusUpdate({ paymentStatus, paymentReference });
    values.push(id);
    return getDb().prepare(
      `UPDATE purchases SET ${fields.join(', ')} WHERE id = ?`
    ).run(...values);
  },

  updateStatusIfPending(id, { paymentStatus, paymentReference }) {
    const { fields, values } = buildStatusUpdate({ paymentStatus, paymentReference });
    values.push(id);
    return getDb().prepare(
      `UPDATE purchases SET ${fields.join(', ')} WHERE id = ? AND payment_status = 'pending'`
    ).run(...values);
  },

  /**
   * Get all pending purchases (for payment monitor)
   */
  getPending() {
    return getDb().prepare(
      `SELECT * FROM purchases WHERE payment_status = 'pending' ORDER BY created_at ASC`
    ).all();
  },

  /**
   * Check if a unique amount is already used by an active order
   */
  isUniqueAmountTaken(uniqueAmount) {
    const row = getDb().prepare(
      `SELECT COUNT(*) as count FROM purchases
       WHERE unique_amount = ? AND payment_status = 'pending'`
    ).get(uniqueAmount);
    return row.count > 0;
  },

  getByUser(telegramUserId, limit = 10) {
    return getDb().prepare(
      'SELECT * FROM purchases WHERE telegram_user_id = ? ORDER BY created_at DESC LIMIT ?'
    ).all(telegramUserId, limit);
  },

  getById(id) {
    return getDb().prepare('SELECT * FROM purchases WHERE id = ?').get(id);
  },
};

module.exports = Purchase;
