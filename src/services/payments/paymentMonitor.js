const Purchase = require('../../db/models/Purchase');
const UsdtBep20Service = require('./usdtBep20');
const UsdtTrc20Service = require('./usdtTrc20');
const BinanceApiClient = require('./binancePay');
const PaymentService = require('../paymentService');
const User = require('../../db/models/User');
const config = require('../../config');
const logger = require('../../utils/logger');
const { MESSAGES } = require('../../utils/constants');

let monitorInterval = null;
let botInstance = null;
let isChecking = false;

const ORDER_EXPIRY_MINUTES = config.payment.orderExpiryMinutes || 15;

/**
 * Background payment monitor.
 * Polls for completed USDT BEP-20 / TRC-20 payments and Binance deposits,
 * then auto-confirms matching orders.
 * Binance Transfer orders are also checked manually by admin as fallback.
 *
 * Each cycle:
 *   1. Expire stale orders (older than ORDER_EXPIRY_MINUTES).
 *   2. Fetch pending blockchain + Binance orders.
 *   3. Check each order against on-chain transfers or deposit history.
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

      // Step 2: Fetch pending orders (blockchain + Binance)
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
          } else if (purchase.payment_provider === 'binance_transfer') {
            await this.checkBinanceDepositPayment(purchase);
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
   * Binance Transfer orders get a longer 30-minute window since deposit
   * confirmation can take longer than on-chain transfers.
   */
  async expireStaleOrders() {
    const BINANCE_EXPIRY_MINUTES = 30;
    const expired = Purchase.expirePendingOrders(ORDER_EXPIRY_MINUTES, BINANCE_EXPIRY_MINUTES);
    if (expired.length === 0) return;

    logger.info('Expired stale orders', {
      count: expired.length,
      orderIds: expired.map(o => o.id),
    });

    if (!botInstance) return;

    for (const order of expired) {
      try {
        const expiryMins = order.payment_provider === 'binance_transfer' ? BINANCE_EXPIRY_MINUTES : ORDER_EXPIRY_MINUTES;
        await botInstance.sendMessage(order.telegram_user_id, [
          '⏰ *Order Expired*',
          '',
          `📋 Order #${order.id} has expired (no payment received within ${expiryMins} minutes).`,
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

  /**
   * Check for a Binance deposit matching this order's unique amount.
   * Uses the deposit history API (/sapi/v1/capital/deposit/hisrec).
   */
  async checkBinanceDepositPayment(purchase) {
    if (!BinanceApiClient.isConfigured()) return;

    const expectedAmount = parseFloat(purchase.unique_amount);
    if (!expectedAmount) {
      logger.warn('Binance order has no unique_amount', { purchaseId: purchase.id });
      return;
    }

    // Convert order creation time to ms for the deposit history API
    const createdAtUtc = purchase.created_at.endsWith('Z') ? purchase.created_at : purchase.created_at.replace(' ', 'T') + 'Z';
    const orderTimestampMs = new Date(createdAtUtc).getTime() - 60000; // 1 min buffer
    if (!Number.isFinite(orderTimestampMs)) {
      logger.warn('Binance order has invalid created_at timestamp', { purchaseId: purchase.id });
      return;
    }

    // Collect already-used deposit references
    const usedRefs = Purchase.getUsedPaymentReferences();

    const deposit = await BinanceApiClient.findMatchingDeposit(expectedAmount, orderTimestampMs, usedRefs);
    if (!deposit) return;

    // Use appropriate reference prefix based on where the match came from
    const reference = deposit.source === 'pay_transactions'
      ? `binance_pay_${deposit.txId}`
      : `binance_deposit_${deposit.txId}`;
    const confirmed = await this.confirmPurchase(purchase, reference);
    if (!confirmed) return;

    logger.info('Binance payment auto-confirmed', {
      purchaseId: purchase.id,
      txId: deposit.txId,
      amount: deposit.amount,
      source: deposit.source,
      network: deposit.network,
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

      // Notify referrer if they earned a reward
      if (result.referrerRewarded) {
        try {
          const referrerBalance = User.getBalance(result.referrerRewarded);
          const rewardMsg = MESSAGES.REFERRAL_REWARD_NOTIFY
            .replace('{reward}', config.referral.rewardCredits)
            .replace('{balance}', referrerBalance);
          await botInstance.sendMessage(result.referrerRewarded, rewardMsg, {
            parse_mode: 'Markdown',
          });
        } catch (err) {
          logger.warn('Could not notify referrer of reward', {
            referrerId: result.referrerRewarded,
            error: err.message,
          });
        }
      }
    }

    return true;
  },
};

module.exports = PaymentMonitor;
