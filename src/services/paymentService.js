const Purchase = require('../db/models/Purchase');
const CreditService = require('./creditService');
const UsdtBep20Service = require('./payments/usdtBep20');
const BinancePayService = require('./payments/binancePay');
const config = require('../config');
const logger = require('../utils/logger');

const PaymentService = {
  /**
   * Create a USDT BEP-20 payment order.
   * Generates a unique payment amount for on-chain matching.
   */
  createUsdtOrder(telegramUserId, pkg) {
    const baseAmount = parseFloat(pkg.price);

    // Generate unique amount and ensure it's not already in use
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
   * Create a Binance Pay order.
   * Returns checkout URL for the user.
   */
  async createBinancePayOrder(telegramUserId, pkg) {
    const amount = parseFloat(pkg.price);
    const merchantTradeNo = `PVB_${telegramUserId}_${Date.now()}`;

    const bpOrder = await BinancePayService.createOrder({
      merchantTradeNo,
      amount,
      description: `PixVerifyBot - ${pkg.label}`,
    });

    if (!bpOrder) {
      return { orderId: null, error: 'Failed to create Binance Pay order' };
    }

    const orderId = Purchase.create({
      telegramUserId,
      amount: pkg.price,
      creditsAdded: pkg.credits,
      paymentProvider: 'binance_pay',
      paymentMethod: 'Binance Pay',
      paymentReference: merchantTradeNo, // Used for status polling
      checkoutUrl: bpOrder.checkoutUrl,
    });

    logger.info('Binance Pay order created', { orderId, merchantTradeNo, telegramUserId });

    return {
      orderId,
      method: 'binance_pay',
      checkoutUrl: bpOrder.checkoutUrl,
      merchantTradeNo,
    };
  },

  /**
   * Manually confirm payment and add credits.
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

  /**
   * Get purchase history for user
   */
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
    if (config.payment.binancePay.enabled) {
      methods.push({ id: 'binance_pay', label: '🟡 Binance Pay' });
    }
    return methods;
  },
};

module.exports = PaymentService;
