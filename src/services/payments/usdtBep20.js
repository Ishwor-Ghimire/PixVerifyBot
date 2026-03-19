const axios = require('axios');
const config = require('../../config');
const logger = require('../../utils/logger');

const USDT_CONTRACT = '0x55d398326f99059fF775485246999027B3197955'; // USDT on BSC

/**
 * USDT BEP-20 payment detection via BscScan API.
 * Monitors incoming USDT transfers to the configured wallet.
 * Each order uses a unique amount (base + random decimals) to match payments.
 */
const UsdtBep20Service = {
  /**
   * Generate a unique payment amount by adding random small decimals.
   * e.g. base $12.50 → $12.5017 or $12.5083
   */
  generateUniqueAmount(baseAmount) {
    const suffix = Math.floor(Math.random() * 9000 + 1000); // 1000–9999
    return parseFloat((baseAmount + suffix / 1000000).toFixed(6));
  },

  /**
   * Fetch recent USDT BEP-20 token transfers TO our wallet
   */
  async getRecentTransfers() {
    const { walletAddress, bscscanApiKey } = config.payment.usdt;
    if (!walletAddress || !bscscanApiKey) {
      logger.warn('USDT BEP-20 not configured (missing wallet or BscScan key)');
      return [];
    }

    try {
      const { data } = await axios.get('https://api.bscscan.com/api', {
        params: {
          module: 'account',
          action: 'tokentx',
          contractaddress: USDT_CONTRACT,
          address: walletAddress,
          page: 1,
          offset: 50,
          sort: 'desc',
          apikey: bscscanApiKey,
        },
        timeout: 10000,
      });

      if (data.status !== '1' || !Array.isArray(data.result)) {
        return [];
      }

      // Filter only incoming transfers TO our wallet
      return data.result
        .filter(tx => tx.to.toLowerCase() === walletAddress.toLowerCase())
        .map(tx => ({
          hash: tx.hash,
          from: tx.from,
          amount: parseFloat(tx.value) / 1e18, // USDT has 18 decimals on BSC
          timestamp: parseInt(tx.timeStamp, 10),
          blockNumber: parseInt(tx.blockNumber, 10),
        }));
    } catch (err) {
      logger.error('BscScan API error', { error: err.message });
      return [];
    }
  },

  /**
   * Check if a specific amount has been received (within tolerance)
   * Returns the matching transaction hash, or null
   */
  async findMatchingTransfer(expectedAmount, afterTimestamp) {
    const transfers = await this.getRecentTransfers();
    const tolerance = 0.0001; // 0.01 cent tolerance

    for (const tx of transfers) {
      if (tx.timestamp < afterTimestamp) continue;
      if (Math.abs(tx.amount - expectedAmount) < tolerance) {
        return tx;
      }
    }
    return null;
  },
};

module.exports = UsdtBep20Service;
