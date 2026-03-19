const Purchase = require('../db/models/Purchase');
const CreditService = require('./creditService');
const UsdtBep20Service = require('./payments/usdtBep20');
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
   * Create a Binance Transfer order (admin confirms manually).
   * User sends USDT to admin's Binance Pay ID.
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
   * Confirm payment and add credits (used by admin /confirm).
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

  /**
   * Get available payment methods based on configuration
   */
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
