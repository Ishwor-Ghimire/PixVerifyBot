const Purchase = require('../../db/models/Purchase');
const UsdtBep20Service = require('./usdtBep20');
const UsdtTrc20Service = require('./usdtTrc20');
const PaymentService = require('../paymentService');
const config = require('../../config');
const logger = require('../../utils/logger');

let monitorInterval = null;
let botInstance = null;
let isChecking = false;

const ORDER_EXPIRY_MINUTES = config.payment.orderExpiryMinutes || 15;

/**
 * Background payment monitor.
 * Polls for completed USDT BEP-20 / TRC-20 payments and auto-confirms.
 * Binance Transfer orders are confirmed manually by admin.
 *
 * Each cycle:
 *   1. Expire stale orders (older than ORDER_EXPIRY_MINUTES).
 *   2. Fetch only blockchain-based pending orders.
 *   3. Check each order against on-chain transfers.
 */
const PaymentMonitor = {
  start(bot, intervalMs = 15000) {
    botInstance = bot;
    if (monitorInterval) return;

    logger.info('Payment monitor started', { intervalMs, orderExpiryMinutes: ORDER_EXPIRY_MINUTES });
    monitorInterval = setInterval(() => this.checkPendingPayments(), intervalMs);

    // Run immediately on start
    this.checkPendingPayments();
  },

  stop() {
    if (monitorInterval) {
      clearInterval(monitorInterval);
      monitorInterval = null;
      logger.info('Payment monitor stopped');
    }
  },

  async checkPendingPayments() {
    if (isChecking) return;

    isChecking = true;
    try {
      // Step 1: Expire old orders
      await this.expireStaleOrders();

      // Step 2: Only fetch blockchain-based pending orders
      const pending = Purchase.getPendingBlockchain();
      if (pending.length === 0) return;

      logger.info('Payment monitor cycle', {
        pendingCount: pending.length,
        orders: pending.map(p => ({
          id: p.id,
          provider: p.payment_provider,
          uniqueAmount: p.unique_amount,
          createdAt: p.created_at,
        })),
      });

      for (const purchase of pending) {
        try {
          if (purchase.payment_provider === 'usdt_bep20') {
            await this.checkUsdtPayment(purchase);
          } else if (purchase.payment_provider === 'usdt_trc20') {
            await this.checkUsdtTrc20Payment(purchase);
          }
        } catch (err) {
          logger.error('Payment check error', {
            purchaseId: purchase.id,
            error: err.message,
            stack: err.stack,
          });
        }
      }
    } catch (err) {
      logger.error('Payment monitor cycle error', { error: err.message });
    } finally {
      isChecking = false;
    }
  },

  /**
   * Mark orders older than ORDER_EXPIRY_MINUTES as expired and notify users.
   */
  async expireStaleOrders() {
    const expired = Purchase.expirePendingOrders(ORDER_EXPIRY_MINUTES);
    if (expired.length === 0) return;

    logger.info('Expired stale orders', {
      count: expired.length,
      orderIds: expired.map(o => o.id),
    });

    if (!botInstance) return;

    for (const order of expired) {
      try {
        await botInstance.sendMessage(order.telegram_user_id, [
          '⏰ *Order Expired*',
          '',
          `📋 Order #${order.id} has expired (no payment received within ${ORDER_EXPIRY_MINUTES} minutes).`,
          '',
          'Use /buy to create a new order.',
        ].join('\n'), { parse_mode: 'Markdown' });
      } catch (err) {
        logger.warn('Could not notify user of order expiry', {
          userId: order.telegram_user_id,
          orderId: order.id,
          error: err.message,
        });
      }
    }
  },

  async checkUsdtPayment(purchase) {
    const expectedAmount = parseFloat(purchase.unique_amount);
    if (!expectedAmount) {
      logger.warn('BEP-20 order has no unique_amount', { purchaseId: purchase.id });
      return;
    }

    // Normalize old-format timestamps: datetime('now') stores 'YYYY-MM-DD HH:MM:SS' (UTC but no Z)
    // new Date() treats strings without Z as local time, so append Z if missing
    const createdAtUtc = purchase.created_at.endsWith('Z') ? purchase.created_at : purchase.created_at.replace(' ', 'T') + 'Z';
    const orderTimestamp = Math.floor(new Date(createdAtUtc).getTime() / 1000) - 60;
    if (!Number.isFinite(orderTimestamp)) {
      logger.warn('BEP-20 order has invalid created_at timestamp', { purchaseId: purchase.id });
      return;
    }

    // Collect already-used tx hashes so findMatchingTransfer skips them
    const usedHashes = Purchase.getUsedPaymentReferences();

    const tx = await UsdtBep20Service.findMatchingTransfer(expectedAmount, orderTimestamp, usedHashes);
    if (!tx) return;

    const confirmed = await this.confirmPurchase(purchase, tx.hash);
    if (!confirmed) return;

    logger.info('USDT BEP-20 payment auto-confirmed', {
      purchaseId: purchase.id,
      txHash: tx.hash,
      amount: tx.amount,
    });
  },

  async checkUsdtTrc20Payment(purchase) {
    const expectedAmount = parseFloat(purchase.unique_amount);
    if (!expectedAmount) return;

    // Normalize old-format timestamps (see checkUsdtPayment)
    const createdAtUtc = purchase.created_at.endsWith('Z') ? purchase.created_at : purchase.created_at.replace(' ', 'T') + 'Z';
    const orderTimestamp = Math.floor(new Date(createdAtUtc).getTime() / 1000) - 60;
    if (!Number.isFinite(orderTimestamp)) {
      logger.warn('TRC-20 order has invalid created_at timestamp', {
        purchaseId: purchase.id,
        createdAt: purchase.created_at,
      });
      return;
    }

    // Collect already-used tx hashes so findMatchingTransfer skips them
    const usedHashes = Purchase.getUsedPaymentReferences();

    const tx = await UsdtTrc20Service.findMatchingTransfer(expectedAmount, orderTimestamp, usedHashes);
    if (!tx) return;

    const confirmed = await this.confirmPurchase(purchase, tx.hash);
    if (!confirmed) return;

    logger.info('USDT TRC-20 payment detected', {
      purchaseId: purchase.id,
      txHash: tx.hash,
      amount: tx.amount,
    });
  },

  async confirmPurchase(purchase, reference) {
    const result = PaymentService.confirmPayment(purchase.id, reference);
    if (!result.success) {
      logger.warn('confirmPayment failed', { purchaseId: purchase.id, error: result.error });
      return false;
    }

    if (botInstance) {
      try {
        const msg = [
          '✅ *Payment Confirmed!*',
          '',
          `💰 *${purchase.credits_added} credits* added to your balance.`,
          `📋 Order #${purchase.id}`,
          '',
          'Use /run to generate a link or /balance to check your balance.',
        ].join('\n');

        await botInstance.sendMessage(purchase.telegram_user_id, msg, {
          parse_mode: 'Markdown',
        });
      } catch (err) {
        logger.warn('Could not notify user of payment', {
          userId: purchase.telegram_user_id,
          error: err.message,
        });
      }
    }

    return true;
  },
};

module.exports = PaymentMonitor;
