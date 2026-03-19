const Purchase = require('../../db/models/Purchase');
const UsdtBep20Service = require('./usdtBep20');
const UsdtTrc20Service = require('./usdtTrc20');
const PaymentService = require('../paymentService');
const logger = require('../../utils/logger');

let monitorInterval = null;
let botInstance = null;
let isChecking = false;

/**
 * Background payment monitor.
 * Polls for completed USDT BEP-20 payments and auto-confirms.
 * Binance Transfer orders are confirmed manually by admin via /confirm.
 */
const PaymentMonitor = {
  start(bot, intervalMs = 15000) {
    botInstance = bot;
    if (monitorInterval) return;

    logger.info('Payment monitor started', { intervalMs });
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
    if (isChecking) {
      return;
    }

    isChecking = true;
    try {
      const pending = Purchase.getPending();
      if (pending.length === 0) return;

      for (const purchase of pending) {
        try {
          // Only auto-check USDT BEP-20 payments
          // Binance Transfer orders are confirmed manually by admin
          if (purchase.payment_provider === 'usdt_bep20') {
            await this.checkUsdtPayment(purchase);
          } else if (purchase.payment_provider === 'usdt_trc20') {
            await this.checkUsdtTrc20Payment(purchase);
          }
        } catch (err) {
          logger.error('Payment check error', {
            purchaseId: purchase.id,
            error: err.message,
          });
        }
      }
    } catch (err) {
      logger.error('Payment monitor cycle error', { error: err.message });
    } finally {
      isChecking = false;
    }
  },

  async checkUsdtPayment(purchase) {
    const expectedAmount = parseFloat(purchase.unique_amount);
    if (!expectedAmount) return;

    const orderTimestamp = Math.floor(new Date(purchase.created_at).getTime() / 1000) - 60;

    const tx = await UsdtBep20Service.findMatchingTransfer(expectedAmount, orderTimestamp);
    if (!tx) return;

    const confirmed = await this.confirmPurchase(purchase, tx.hash);
    if (!confirmed) return;

    logger.info('USDT BEP-20 payment detected', {
      purchaseId: purchase.id,
      txHash: tx.hash,
      amount: tx.amount,
    });
  },

  async checkUsdtTrc20Payment(purchase) {
    const expectedAmount = parseFloat(purchase.unique_amount);
    if (!expectedAmount) return;

    const orderTimestamp = Math.floor(new Date(purchase.created_at).getTime() / 1000) - 60;

    const tx = await UsdtTrc20Service.findMatchingTransfer(expectedAmount, orderTimestamp);
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
