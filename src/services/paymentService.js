const Purchase = require('../db/models/Purchase');
const UsdtBep20Service = require('./payments/usdtBep20');
const BinanceApiClient = require('./payments/binancePay');
const config = require('../config');
const { getDb } = require('../db/database');
const User = require('../db/models/User');
const logger = require('../utils/logger');

const PaymentService = {
  /**
   * Create a USDT BEP-20 payment order (auto-detected via blockchain).
   */
  createUsdtOrder(telegramUserId, pkg) {
    const baseAmount = parseFloat(pkg.price);

    let uniqueAmount;
    let attempts = 0;
    do {
      uniqueAmount = UsdtBep20Service.generateUniqueAmount(baseAmount);
      attempts++;
    } while (Purchase.isUniqueAmountTaken(uniqueAmount) && attempts < 20);

    if (Purchase.isUniqueAmountTaken(uniqueAmount)) {
      logger.warn('BEP-20 unique amount collision after 20 attempts', { baseAmount, telegramUserId });
      return {
        error: 'AMOUNT_COLLISION',
        message: 'Too many active orders with similar amounts. Please try again shortly.',
      };
    }

    const orderId = Purchase.create({
      telegramUserId,
      amount: pkg.price,
      creditsAdded: pkg.credits,
      paymentProvider: 'usdt_bep20',
      paymentMethod: 'USDT (BEP-20)',
      uniqueAmount,
    });

    logger.info('USDT BEP-20 order created', { orderId, uniqueAmount, telegramUserId });

    return {
      orderId,
      method: 'usdt_bep20',
      uniqueAmount,
      walletAddress: config.payment.usdt.walletAddress,
    };
  },

  /**
   * Create a USDT TRC-20 payment order (auto-detected via blockchain).
   */
  createUsdtTrc20Order(telegramUserId, pkg) {
    const baseAmount = parseFloat(pkg.price);

    // TRC20 uses the same unique amount logic
    const UsdtTrc20Service = require('./payments/usdtTrc20');
    let uniqueAmount;
    let attempts = 0;
    do {
      uniqueAmount = UsdtTrc20Service.generateUniqueAmount(baseAmount);
      attempts++;
    } while (Purchase.isUniqueAmountTaken(uniqueAmount) && attempts < 20);

    if (Purchase.isUniqueAmountTaken(uniqueAmount)) {
      logger.warn('TRC-20 unique amount collision after 20 attempts', { baseAmount, telegramUserId });
      return {
        error: 'AMOUNT_COLLISION',
        message: 'Too many active orders with similar amounts. Please try again shortly.',
      };
    }

    const orderId = Purchase.create({
      telegramUserId,
      amount: pkg.price,
      creditsAdded: pkg.credits,
      paymentProvider: 'usdt_trc20',
      paymentMethod: 'USDT (TRC-20)',
      uniqueAmount,
    });

    logger.info('USDT TRC-20 order created', { orderId, uniqueAmount, telegramUserId });

    return {
      orderId,
      method: 'usdt_trc20',
      uniqueAmount,
      walletAddress: config.payment.usdtTrc20.walletAddress,
    };
  },

  /**
   * Create a Binance Transfer order.
   */
  createBinanceTransferOrder(telegramUserId, pkg) {
    const orderId = Purchase.create({
      telegramUserId,
      amount: pkg.price,
      creditsAdded: pkg.credits,
      paymentProvider: 'binance_transfer',
      paymentMethod: 'Binance Transfer',
    });

    logger.info('Binance Transfer order created', { orderId, telegramUserId });

    return {
      orderId,
      method: 'binance_transfer',
      binancePayId: config.payment.binanceTransfer.payId,
    };
  },

  /**
   * Verify a Binance Transfer using the order ID from user's receipt.
   * Queries Binance API to confirm the payment was received.
   */
  async verifyBinancePayment(purchaseId, telegramUserId, binanceOrderId) {
    if (!config.payment.binanceTransfer.autoVerifyEnabled) {
      return {
        success: false,
        reason: 'Automatic Binance verification is not configured yet. Please contact support.',
      };
    }

    const purchase = Purchase.getById(purchaseId);
    if (!purchase) {
      return { success: false, reason: 'Order not found.' };
    }
    if (purchase.telegram_user_id !== telegramUserId) {
      return { success: false, reason: 'That order does not belong to your account.' };
    }
    if (purchase.payment_provider !== 'binance_transfer') {
      return { success: false, reason: 'This order cannot be verified with Binance.' };
    }
    if (purchase.payment_status !== 'pending') {
      return {
        success: false,
        reason: purchase.payment_status === 'completed'
          ? 'Order already confirmed.'
          : `Order is already ${purchase.payment_status}.`,
      };
    }

    const expectedAmount = parseFloat(purchase.amount);
    const result = await BinanceApiClient.verifyPayment(binanceOrderId, expectedAmount);

    if (!result.verified) {
      logger.warn('Binance payment verification failed', {
        purchaseId,
        binanceOrderId,
        reason: result.reason,
      });
      return { success: false, reason: result.reason };
    }

    const confirmation = this.confirmPayment(purchaseId, `binance_${binanceOrderId}`);
    if (!confirmation.success) {
      return {
        success: false,
        reason: confirmation.error === 'Already confirmed'
          ? 'Order already confirmed.'
          : confirmation.error,
      };
    }

    logger.info('Binance payment auto-verified', {
      purchaseId,
      binanceOrderId,
      credits: confirmation.credits,
    });

    return { success: true, credits: confirmation.credits };
  },

  /**
   * Confirm payment manually (used by admin /confirm).
   */
  confirmPayment(orderId, paymentReference = null) {
    const db = getDb();
    const result = db.transaction(() => {
      const purchase = Purchase.getById(orderId);
      if (!purchase) {
        return { success: false, error: 'Order not found' };
      }
      if (purchase.payment_status === 'completed') {
        return { success: false, error: 'Already confirmed' };
      }
      if (purchase.payment_status !== 'pending') {
        return { success: false, error: `Order is ${purchase.payment_status}` };
      }

      const update = Purchase.updateStatusIfPending(orderId, {
        paymentStatus: 'completed',
        paymentReference,
      });
      if (update.changes !== 1) {
        return { success: false, error: 'Already confirmed' };
      }

      User.updateBalance(purchase.telegram_user_id, purchase.credits_added);
      return {
        success: true,
        credits: purchase.credits_added,
        telegramUserId: purchase.telegram_user_id,
      };
    })();

    if (result.success) {
      logger.info('Payment confirmed', { orderId, credits: result.credits });
    }

    return result;
  },

  getHistory(telegramUserId) {
    return Purchase.getByUser(telegramUserId);
  },

  getAvailableMethods() {
    const methods = [];
    if (config.payment.usdt.enabled) {
      methods.push({ id: 'usdt_bep20', label: '💎 USDT (BEP-20) ( ✅ Automatic)' });
    }
    if (config.payment.usdtTrc20.enabled) {
      methods.push({ id: 'usdt_trc20', label: '🟥 USDT (TRC-20) ( ✅ Automatic)' });
    }
    if (config.payment.binanceTransfer.enabled) {
      methods.push({ id: 'binance_transfer', label: '🟡 Binance Pay (Manual)' });
    }
    return methods;
  },
};

module.exports = PaymentService;
