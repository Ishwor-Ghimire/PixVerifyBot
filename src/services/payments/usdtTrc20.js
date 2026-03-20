const axios = require('axios');
const config = require('../../config');
const logger = require('../../utils/logger');

const USDT_TRC20_CONTRACT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'; // USDT on TRON
const MAX_PAGES = 5; // Safety cap to avoid infinite pagination

/**
 * USDT TRC-20 payment detection via TronGrid API.
 * Monitors incoming USDT transfers to the configured TRON wallet.
 * Supports pagination via TronGrid's fingerprint cursor.
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
   * Fetch recent USDT TRC-20 token transfers TO our wallet.
   * Follows TronGrid pagination to avoid missing transfers on busy wallets.
   * Stops paginating when transfers are older than afterTimestamp.
   */
  async getRecentTransfers(afterTimestamp = null) {
    const { walletAddress } = config.payment.usdtTrc20;
    if (!walletAddress) {
      logger.warn('USDT TRC-20 not configured (missing wallet address)');
      return [];
    }

    try {
      const allTransfers = [];
      let fingerprint = null;

      for (let page = 0; page < MAX_PAGES; page++) {
        const params = {
          contract_address: USDT_TRC20_CONTRACT,
          limit: 200,
        };
        if (fingerprint) {
          params.fingerprint = fingerprint;
        }

        const { data } = await axios.get(
          `https://api.trongrid.io/v1/accounts/${walletAddress}/transactions/trc20`,
          { params, timeout: 10000 }
        );

        if (!data || !Array.isArray(data.data) || data.data.length === 0) {
          break;
        }

        // Filter only incoming transfers TO our wallet
        let oldestTxTimestamp = Infinity;
        for (const tx of data.data) {
          if (tx.to !== walletAddress) continue;

          const txTimestamp = Math.floor(parseInt(tx.block_timestamp, 10) / 1000);
          oldestTxTimestamp = Math.min(oldestTxTimestamp, txTimestamp);

          // Skip transfers older than our cutoff
          if (afterTimestamp && txTimestamp < afterTimestamp) continue;

          allTransfers.push({
            hash: tx.transaction_id,
            from: tx.from,
            amount: parseFloat(tx.value) / 1000000, // USDT on TRON has 6 decimals
            timestamp: txTimestamp,
          });
        }

        // Stop paginating if oldest transfer in this page is before our cutoff
        if (afterTimestamp && oldestTxTimestamp < afterTimestamp) {
          break;
        }

        // Check for next page
        fingerprint = data.meta?.fingerprint || null;
        if (!fingerprint) break;
      }

      return allTransfers;
    } catch (err) {
      logger.error('TronGrid API error', { error: err.message });
      return [];
    }
  },

  /**
   * Check if a specific amount has been received (within tolerance).
   * @param {number} expectedAmount - The unique amount to match
   * @param {number} afterTimestamp - Only consider transfers after this time
   * @param {Set<string>} [excludeHashes] - Tx hashes to skip (already used by other orders)
   * @returns {object|null} The matching transaction, or null
   */
  async findMatchingTransfer(expectedAmount, afterTimestamp, excludeHashes = null) {
    const transfers = await this.getRecentTransfers(afterTimestamp);
    const tolerance = 0.0005; // Half the 0.001 step size — prevents adjacent amount overlap

    for (const tx of transfers) {
      if (afterTimestamp && tx.timestamp < afterTimestamp) continue;
      if (excludeHashes && excludeHashes.has(tx.hash)) continue;
      if (Math.abs(tx.amount - expectedAmount) < tolerance) {
        return tx;
      }
    }
    return null;
  },
};

module.exports = UsdtTrc20Service;
