const Purchase = require('../db/models/Purchase');
const CreditService = require('./creditService');
const UsdtBep20Service = require('./payments/usdtBep20');
const BinanceApiClient = require('./payments/binancePay');
const config = require('../config');
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
  async verifyBinancePayment(purchaseId, binanceOrderId) {
    const purchase = Purchase.getById(purchaseId);
    if (!purchase) {
      return { success: false, reason: 'Order not found.' };
    }
    if (purchase.payment_status === 'completed') {
      return { success: false, reason: 'Order already confirmed.' };
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

    // Payment verified — confirm and add credits
    Purchase.updateStatus(purchaseId, {
      paymentStatus: 'completed',
      paymentReference: `binance_${binanceOrderId}`,
    });

    CreditService.addCredits(purchase.telegram_user_id, purchase.credits_added);

    logger.info('Binance payment auto-verified', {
      purchaseId,
      binanceOrderId,
      credits: purchase.credits_added,
    });

    return { success: true, credits: purchase.credits_added };
  },

  /**
   * Confirm payment manually (used by admin /confirm).
   */
  confirmPayment(orderId, paymentReference = null) {
    const purchase = Purchase.getById(orderId);
    if (!purchase) {
      return { success: false, error: 'Order not found' };
    }
    if (purchase.payment_status === 'completed') {
      return { success: false, error: 'Already confirmed' };
    }

    Purchase.updateStatus(orderId, {
      paymentStatus: 'completed',
      paymentReference,
    });

    CreditService.addCredits(purchase.telegram_user_id, purchase.credits_added);
    logger.info('Payment confirmed', { orderId, credits: purchase.credits_added });

    return { success: true, credits: purchase.credits_added };
  },

  getHistory(telegramUserId) {
    return Purchase.getByUser(telegramUserId);
  },

  getAvailableMethods() {
    const methods = [];
    if (config.payment.usdt.enabled) {
      methods.push({ id: 'usdt_bep20', label: '💎 USDT (BEP-20)' });
    }
    if (config.payment.binanceTransfer.enabled) {
      methods.push({ id: 'binance_transfer', label: '🟡 Binance Transfer' });
    }
    return methods;
  },
};

module.exports = PaymentService;
