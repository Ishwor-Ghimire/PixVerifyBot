const { getDb } = require('../database');

function buildStatusUpdate({ paymentStatus, paymentReference }) {
  const fields = ['payment_status = ?'];
  const values = [paymentStatus];

  if (paymentReference !== undefined) {
    fields.push('payment_reference = ?');
    values.push(paymentReference);
  }
  if (['completed', 'failed', 'expired', 'rejected'].includes(paymentStatus)) {
    fields.push('completed_at = ?');
    values.push(new Date().toISOString());
  }

  return { fields, values };
}

/**
 * Generate a random 10-digit numeric order ID (1000000000–9999999999).
 */
function generateOrderId() {
  return Math.floor(1000000000 + Math.random() * 9000000000);
}

const Purchase = {
  create({ telegramUserId, amount, creditsAdded, paymentProvider = null, paymentMethod = null, uniqueAmount = null, checkoutUrl = null, paymentReference = null }) {
    let orderId;
    let attempts = 0;
    do {
      orderId = generateOrderId();
      attempts++;
    } while (
      getDb().prepare('SELECT 1 FROM purchases WHERE id = ?').get(orderId) && attempts < 10
    );

    // Explicitly set ISO 8601 timestamp — the table DEFAULT may still be datetime('now')
    // which produces 'YYYY-MM-DD HH:MM:SS' (no T/Z) on databases created before the migration fix.
    const createdAt = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

    getDb().prepare(
      `INSERT INTO purchases (id, telegram_user_id, amount, credits_added, payment_provider, payment_status, payment_method, unique_amount, checkout_url, payment_reference, created_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)`
    ).run(orderId, telegramUserId, amount, creditsAdded, paymentProvider, paymentMethod, uniqueAmount, checkoutUrl, paymentReference, createdAt);
    return orderId;
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
   * Get only blockchain-based pending orders (for the payment monitor).
   */
  getPendingBlockchain() {
    return getDb().prepare(
      `SELECT * FROM purchases
       WHERE payment_status = 'pending'
         AND payment_provider IN ('usdt_bep20', 'usdt_trc20')
       ORDER BY created_at ASC`
    ).all();
  },

  /**
   * Expire pending orders older than the given number of minutes.
   * Returns the list of expired orders (for notification purposes).
   *
   * Handles both timestamp formats:
   *   - Old: 'YYYY-MM-DD HH:MM:SS' (from datetime('now') DEFAULT)
   *   - New: 'YYYY-MM-DDTHH:MM:SSZ' (ISO 8601)
   * We normalize DB timestamps in SQL using REPLACE + || 'Z' to ensure
   * consistent string comparison against the ISO cutoff.
   */
  expirePendingOrders(expiryMinutes) {
    const cutoff = new Date(Date.now() - expiryMinutes * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');

    // Normalize: replace space with T, strip any existing Z, then append Z
    // This ensures both 'YYYY-MM-DD HH:MM:SS' and 'YYYY-MM-DDTHH:MM:SSZ' become 'YYYY-MM-DDTHH:MM:SSZ'
    const normalizeExpr = `REPLACE(REPLACE(created_at, ' ', 'T'), 'Z', '') || 'Z'`;

    const expired = getDb().prepare(
      `SELECT * FROM purchases
       WHERE payment_status = 'pending'
         AND ${normalizeExpr} < ?`
    ).all(cutoff);

    if (expired.length > 0) {
      const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
      getDb().prepare(
        `UPDATE purchases
         SET payment_status = 'expired', completed_at = ?
         WHERE payment_status = 'pending'
           AND ${normalizeExpr} < ?`
      ).run(now, cutoff);
    }

    return expired;
  },

  /**
   * Check if a unique amount is already used by an active order.
   * Uses ROUND to avoid float vs string comparison issues.
   */
  isUniqueAmountTaken(uniqueAmount) {
    const row = getDb().prepare(
      `SELECT COUNT(*) as count FROM purchases
       WHERE ROUND(unique_amount, 3) = ROUND(?, 3) AND payment_status = 'pending'`
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

  getStats() {
    const row = getDb().prepare(`
      SELECT 
        COUNT(*) as total_orders,
        SUM(amount) as total_revenue,
        SUM(credits_added) as total_credits_sold
      FROM purchases 
      WHERE payment_status = 'completed'
    `).get();
    
    return {
      totalOrders: row.total_orders || 0,
      totalRevenue: row.total_revenue || 0,
      totalCreditsSold: row.total_credits_sold || 0,
    };
  },
  /**
   * Check if a payment reference (tx hash) has already been used by a completed order.
   * Prevents the same transaction from being submitted to multiple orders.
   */
  isPaymentReferenceUsed(reference) {
    if (!reference) return false;
    const row = getDb().prepare(
      `SELECT COUNT(*) as count FROM purchases
       WHERE payment_reference = ? AND payment_status = 'completed'`
    ).get(reference);
    return row.count > 0;
  },

  /**
   * Get all payment references used by completed orders as a Set.
   * Used by findMatchingTransfer to skip already-credited tx hashes.
   */
  getUsedPaymentReferences() {
    const rows = getDb().prepare(
      `SELECT payment_reference FROM purchases
       WHERE payment_reference IS NOT NULL AND payment_status = 'completed'`
    ).all();
    return new Set(rows.map(r => r.payment_reference));
  },
};

module.exports = Purchase;
