const crypto = require('crypto');
const axios = require('axios');
const config = require('../../config');
const logger = require('../../utils/logger');

const BASE_URL = 'https://api.binance.com';

/**
 * Binance Exchange API client for verifying Pay transactions.
 * Uses HMAC-SHA256 signed requests with the user's API key.
 */
const BinanceApiClient = {
  isConfigured() {
    return Boolean(
      config.payment.binanceTransfer.apiKey &&
      config.payment.binanceTransfer.apiSecret
    );
  },

  /**
   * Create HMAC-SHA256 signature for Binance API
   */
  _sign(queryString) {
    return crypto
      .createHmac('sha256', config.payment.binanceTransfer.apiSecret)
      .update(queryString)
      .digest('hex');
  },

  /**
   * Make signed GET request to Binance API
   */
  async _signedGet(endpoint, params = {}) {
    if (!this.isConfigured()) {
      throw new Error('Binance API key/secret missing');
    }

    const { apiKey } = config.payment.binanceTransfer;
    params.timestamp = Date.now();
    params.recvWindow = 10000;

    const queryString = Object.entries(params)
      .map(([k, v]) => `${k}=${v}`)
      .join('&');

    const signature = this._sign(queryString);
    const url = `${BASE_URL}${endpoint}?${queryString}&signature=${signature}`;

    const { data } = await axios.get(url, {
      headers: { 'X-MBX-APIKEY': apiKey },
      timeout: 10000,
    });

    return data;
  },

  /**
   * Get recent Pay transactions (both sent and received).
   * Returns transactions from the last N minutes.
   */
  async getPayTransactions(lookbackMinutes = 120) {
    try {
      const startTimestamp = Date.now() - (lookbackMinutes * 60 * 1000);

      const data = await this._signedGet('/sapi/v1/pay/transactions', {
        startTimestamp,
        limit: 100,
      });

      // Log raw response to diagnose response shape issues
      logger.info('Binance Pay API raw response', {
        dataType: typeof data,
        isArray: Array.isArray(data),
        topLevelKeys: data ? Object.keys(data) : [],
        status: data?.status,
        code: data?.code,
        dataLength: Array.isArray(data) ? data.length
          : Array.isArray(data?.data) ? data.data.length
          : Array.isArray(data?.rows) ? data.rows.length
          : Array.isArray(data?.result) ? data.result.length
          : 'unknown',
      });

      const transactions = Array.isArray(data)
        ? data
        : Array.isArray(data?.data)
          ? data.data
          : Array.isArray(data?.rows)
            ? data.rows
            : Array.isArray(data?.result)
              ? data.result
              : null;

      if (!transactions) {
        logger.warn('Unexpected Pay transactions response shape', { data });
        return [];
      }

      logger.info('Binance Pay transactions fetched', { count: transactions.length });
      return transactions;
    } catch (err) {
      logger.error('Failed to fetch Pay transactions', {
        status: err.response?.status,
        error: err.response?.data || err.message,
      });
      return [];
    }
  },

  /**
   * Verify a specific Pay transaction by order ID.
   * Checks if a payment was received with the expected amount.
   * Returns { verified, transaction } or { verified: false, reason }
   */
  async verifyPayment(orderIdFromUser, expectedAmount) {
    try {
      const requestedOrderId = String(orderIdFromUser).trim();
      const transactions = await this.getPayTransactions(120);

      if (transactions.length === 0) {
        return {
          verified: false,
          reason: 'No recent Binance Pay transactions found in the last 2 hours.\n\n💡 Possible causes:\n• API key is missing "Pay Transaction History" read permission\n• Transaction not yet settled on Binance\n• Contact /support if this persists',
        };
      }

      // Log the first transaction's keys so we can see the actual field names Binance uses
      if (transactions[0]) {
        logger.info('Sample Binance Pay transaction fields', {
          keys: Object.keys(transactions[0]),
          sample: transactions[0],
        });
      }

      // Search for matching transaction — try ALL known Binance Pay field names
      for (const tx of transactions) {
        const txOrderId = String(
          tx.orderNumber ||
          tx.transactionId ||
          tx.orderId ||
          tx.bizId ||
          tx.merchantTradeNo ||
          tx.prepayId ||
          tx.tradeId ||
          ''
        ).trim();

        if (txOrderId === requestedOrderId) {
          const receivedAmount = parseFloat(tx.amount || tx.totalAmount || '0');
          const currency = tx.currency || tx.orderCurrency || 'USDT';

          if (receivedAmount <= 0) {
            return { verified: false, reason: 'Transaction found but it is an outgoing payment, not incoming.' };
          }

          if (Math.abs(receivedAmount - expectedAmount) > 0.01) {
            return {
              verified: false,
              reason: `Amount mismatch. Expected $${expectedAmount}, got $${receivedAmount} ${currency}.`,
            };
          }

          return {
            verified: true,
            transaction: {
              orderId: txOrderId,
              amount: receivedAmount,
              currency,
              time: tx.transactionTime || tx.createTime,
            },
          };
        }
      }

      return {
        verified: false,
        reason: 'Transaction ID not found in your recent Binance Pay history. Please double-check the ID and try again.',
      };
    } catch (err) {
      logger.error('Payment verification error', { error: err.message });
      return { verified: false, reason: 'Verification service error. Please try again or contact support.' };
    }
  },
};

module.exports = BinanceApiClient;
