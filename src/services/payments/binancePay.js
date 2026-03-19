const crypto = require('crypto');
const axios = require('axios');
const config = require('../../config');
const logger = require('../../utils/logger');

/**
 * Binance Pay merchant API integration.
 * Creates payment orders and polls for completion.
 *
 * Docs: https://developers.binance.com/docs/binance-pay/api-order-create-v2
 */
const BinancePayService = {
  /**
   * Generate request signature for Binance Pay API
   */
  _generateSignature(timestamp, nonce, body) {
    const payload = `${timestamp}\n${nonce}\n${body}\n`;
    return crypto
      .createHmac('sha512', config.payment.binancePay.secretKey)
      .update(payload)
      .digest('hex')
      .toUpperCase();
  },

  /**
   * Make authenticated request to Binance Pay API
   */
  async _request(endpoint, body = {}) {
    const { apiKey } = config.payment.binancePay;
    const timestamp = Date.now();
    const nonce = crypto.randomBytes(16).toString('hex');
    const bodyStr = JSON.stringify(body);
    const signature = this._generateSignature(timestamp, nonce, bodyStr);

    try {
      const { data } = await axios.post(
        `https://bpay.binanceapi.com${endpoint}`,
        body,
        {
          headers: {
            'Content-Type': 'application/json',
            'BinancePay-Timestamp': timestamp,
            'BinancePay-Nonce': nonce,
            'BinancePay-Certificate-SN': apiKey,
            'BinancePay-Signature': signature,
          },
          timeout: 15000,
        }
      );
      return data;
    } catch (err) {
      logger.error('Binance Pay API error', {
        endpoint,
        error: err.response?.data || err.message,
      });
      throw err;
    }
  },

  /**
   * Create a Binance Pay order.
   * Returns { prepayId, checkoutUrl, qrContent }
   */
  async createOrder({ merchantTradeNo, amount, description }) {
    const body = {
      env: { terminalType: 'WEB' },
      merchantTradeNo,
      orderAmount: amount.toFixed(2),
      currency: 'USDT',
      description: description || 'PixVerifyBot Credits',
      goodsDetails: [{
        goodsType: '02', // Virtual goods
        goodsCategory: 'Z000', // Others
        referenceGoodsId: merchantTradeNo,
        goodsName: description || 'Credits',
        goodsUnitAmount: { currency: 'USDT', amount: amount.toFixed(2) },
      }],
    };

    const res = await this._request('/binancepay/openapi/v3/order', body);

    if (res.status !== 'SUCCESS') {
      logger.error('Binance Pay order creation failed', { response: res });
      return null;
    }

    logger.info('Binance Pay order created', {
      merchantTradeNo,
      prepayId: res.data.prepayId,
    });

    return {
      prepayId: res.data.prepayId,
      checkoutUrl: res.data.universalUrl,
      qrContent: res.data.qrcodeLink,
    };
  },

  /**
   * Query order status.
   * Returns status: 'INITIAL' | 'PENDING' | 'PAID' | 'CANCELED' | 'ERROR' | 'EXPIRED'
   */
  async queryOrder(merchantTradeNo) {
    try {
      const res = await this._request('/binancepay/openapi/v3/order/query', {
        merchantTradeNo,
      });

      if (res.status !== 'SUCCESS') {
        return { status: 'ERROR' };
      }

      return {
        status: res.data.status,
        transactionId: res.data.transactionId || null,
        paidAmount: res.data.totalPayAmount ? parseFloat(res.data.totalPayAmount) : 0,
      };
    } catch {
      return { status: 'ERROR' };
    }
  },
};

module.exports = BinancePayService;
