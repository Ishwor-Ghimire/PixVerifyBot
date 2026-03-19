const Purchase = require('../../db/models/Purchase');
const CreditService = require('../creditService');
const UsdtBep20Service = require('./usdtBep20');
const logger = require('../../utils/logger');

let monitorInterval = null;
let botInstance = null;

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
    try {
      const pending = Purchase.getPending();
      if (pending.length === 0) return;

      for (const purchase of pending) {
        try {
          // Only auto-check USDT BEP-20 payments
          // Binance Transfer orders are confirmed manually by admin
          if (purchase.payment_provider === 'usdt_bep20') {
            await this.checkUsdtPayment(purchase);
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
    }
  },

  async checkUsdtPayment(purchase) {
    const expectedAmount = parseFloat(purchase.unique_amount);
    if (!expectedAmount) return;

    const orderTimestamp = Math.floor(new Date(purchase.created_at).getTime() / 1000) - 60;

    const tx = await UsdtBep20Service.findMatchingTransfer(expectedAmount, orderTimestamp);
    if (!tx) return;

    await this.confirmPurchase(purchase, tx.hash);
    logger.info('USDT BEP-20 payment detected', {
      purchaseId: purchase.id,
      txHash: tx.hash,
      amount: tx.amount,
    });
  },

  async confirmPurchase(purchase, reference) {
    Purchase.updateStatus(purchase.id, {
      paymentStatus: 'completed',
      paymentReference: reference,
    });

    CreditService.addCredits(purchase.telegram_user_id, purchase.credits_added);

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
  },
};

module.exports = PaymentMonitor;
