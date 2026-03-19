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
        logger.warn('Unexpected Pay transactions response', { data });
        return [];
      }

      return transactions;
    } catch (err) {
      logger.error('Failed to fetch Pay transactions', {
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
        return { verified: false, reason: 'No recent transactions found. Try again in a moment.' };
      }

      // Search for matching transaction
      for (const tx of transactions) {
        const txOrderId = String(tx.orderNumber || tx.transactionId || tx.orderId || '').trim();

        // Match by order ID (user provides this from their Binance receipt)
        if (txOrderId === requestedOrderId) {
          const receivedAmount = parseFloat(tx.amount);
          const currency = tx.currency || 'USDT';

          // Verify it's a received payment (positive amount)
          if (receivedAmount <= 0) {
            return { verified: false, reason: 'Transaction found but it is an outgoing payment, not incoming.' };
          }

          // Verify amount matches (within small tolerance)
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
              time: tx.transactionTime,
            },
          };
        }
      }

      return { verified: false, reason: 'Transaction not found. Please check the Order ID and try again.' };
    } catch (err) {
      logger.error('Payment verification error', { error: err.message });
      return { verified: false, reason: 'Verification service error. Please try again or contact support.' };
    }
  },
};

module.exports = BinanceApiClient;
