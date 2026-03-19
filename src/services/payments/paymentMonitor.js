const Purchase = require('../../db/models/Purchase');
const CreditService = require('../creditService');
const UsdtBep20Service = require('./usdtBep20');
const BinancePayService = require('./binancePay');
const logger = require('../../utils/logger');

let monitorInterval = null;
let botInstance = null;

/**
 * Background payment monitor.
 * Polls for completed payments across all providers and auto-confirms.
 */
const PaymentMonitor = {
  /**
   * Start the background monitoring loop
   */
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

  /**
   * Check all pending purchases for payment completion
   */
  async checkPendingPayments() {
    try {
      const pending = Purchase.getPending();
      if (pending.length === 0) return;

      for (const purchase of pending) {
        try {
          if (purchase.payment_provider === 'usdt_bep20') {
            await this.checkUsdtPayment(purchase);
          } else if (purchase.payment_provider === 'binance_pay') {
            await this.checkBinancePayment(purchase);
          }
        } catch (err) {
          logger.error('Payment check error', {
            purchaseId: purchase.id,
            provider: purchase.payment_provider,
            error: err.message,
          });
        }
      }
    } catch (err) {
      logger.error('Payment monitor cycle error', { error: err.message });
    }
  },

  /**
   * Check USDT BEP-20 payment by looking for matching transfer
   */
  async checkUsdtPayment(purchase) {
    const expectedAmount = parseFloat(purchase.unique_amount);
    if (!expectedAmount) return;

    // Only look for transfers after the order was created
    const orderTimestamp = Math.floor(new Date(purchase.created_at).getTime() / 1000) - 60;

    const tx = await UsdtBep20Service.findMatchingTransfer(expectedAmount, orderTimestamp);
    if (!tx) return;

    // Payment found — confirm it
    await this.confirmPurchase(purchase, tx.hash);
    logger.info('USDT BEP-20 payment detected', {
      purchaseId: purchase.id,
      txHash: tx.hash,
      amount: tx.amount,
    });
  },

  /**
   * Check Binance Pay order status
   */
  async checkBinancePayment(purchase) {
    const tradeNo = purchase.payment_reference;
    if (!tradeNo) return;

    const result = await BinancePayService.queryOrder(tradeNo);

    if (result.status === 'PAID') {
      await this.confirmPurchase(purchase, result.transactionId || tradeNo);
      logger.info('Binance Pay payment confirmed', {
        purchaseId: purchase.id,
        transactionId: result.transactionId,
      });
    } else if (result.status === 'CANCELED' || result.status === 'EXPIRED') {
      Purchase.updateStatus(purchase.id, {
        paymentStatus: 'expired',
      });
      logger.info('Binance Pay order expired/cancelled', { purchaseId: purchase.id });
    }
  },

  /**
   * Confirm purchase: update status, add credits, notify user
   */
  async confirmPurchase(purchase, reference) {
    Purchase.updateStatus(purchase.id, {
      paymentStatus: 'completed',
      paymentReference: reference,
    });

    CreditService.addCredits(purchase.telegram_user_id, purchase.credits_added);

    // Notify user via Telegram
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
