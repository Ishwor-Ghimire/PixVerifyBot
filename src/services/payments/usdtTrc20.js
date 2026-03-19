const axios = require('axios');
const config = require('../../config');
const logger = require('../../utils/logger');

const USDT_TRC20_CONTRACT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'; // USDT on TRON

/**
 * USDT TRC-20 payment detection via TronGrid API.
 * Monitors incoming USDT transfers to the configured TRON wallet.
 */
const UsdtTrc20Service = {
  /**
   * Generate a unique payment amount by adding random small decimals.
   * e.g. base $12.50 → $12.515 (max 3 decimals for exchange compat)
   */
  generateUniqueAmount(baseAmount) {
    const suffix = Math.floor(Math.random() * 90 + 10); // 10–99
    return parseFloat((baseAmount + suffix / 1000).toFixed(3));
  },

  /**
   * Fetch recent USDT TRC-20 token transfers TO our wallet
   */
  async getRecentTransfers() {
    const { walletAddress } = config.payment.usdtTrc20;
    if (!walletAddress) {
      logger.warn('USDT TRC-20 not configured (missing wallet address)');
      return [];
    }

    try {
      const { data } = await axios.get(`https://api.trongrid.io/v1/accounts/${walletAddress}/transactions/trc20`, {
        params: {
          contract_address: USDT_TRC20_CONTRACT,
          limit: 50,
        },
        timeout: 10000,
      });

      if (!data || !Array.isArray(data.data)) {
        return [];
      }

      // Filter only incoming transfers TO our wallet
      return data.data
        .filter(tx => tx.to === walletAddress)
        .map(tx => ({
          hash: tx.transaction_id,
          from: tx.from,
          amount: parseFloat(tx.value) / 1000000, // USDT on TRON has 6 decimals
          timestamp: Math.floor(parseInt(tx.block_timestamp, 10) / 1000), // Convert ms to s
        }));
    } catch (err) {
      logger.error('TronGrid API error', { error: err.message });
      return [];
    }
  },

  /**
   * Check if a specific amount has been received (within tolerance)
   * Returns the matching transaction hash, or null
   */
  async findMatchingTransfer(expectedAmount, afterTimestamp) {
    const transfers = await this.getRecentTransfers();
    const tolerance = 0.001; // 0.1 cent tolerance for 3-decimal precision

    for (const tx of transfers) {
      if (tx.timestamp < afterTimestamp) continue;
      if (Math.abs(tx.amount - expectedAmount) < tolerance) {
        return tx;
      }
    }
    return null;
  },
};

module.exports = UsdtTrc20Service;
