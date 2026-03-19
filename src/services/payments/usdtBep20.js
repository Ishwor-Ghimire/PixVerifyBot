const axios = require('axios');
const config = require('../../config');
const logger = require('../../utils/logger');

// USDT contract on BSC
const USDT_CONTRACT = '0x55d398326f99059fF775485246999027B3197955';

// Transfer(address,address,uint256) event topic
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

// Free BSC RPC endpoints (fallback chain)
const RPC_ENDPOINTS = [
  'https://bsc-dataseed1.binance.org',
  'https://bsc-dataseed2.binance.org',
  'https://bsc-dataseed3.binance.org',
  'https://bsc-dataseed4.binance.org',
];

let currentRpcIndex = 0;

/**
 * USDT BEP-20 payment detection via BSC RPC logs.
 * Monitors incoming USDT Transfer events to the configured wallet.
 * No API key required — uses free public BSC RPC nodes.
 */
const UsdtBep20Service = {
  /**
   * Generate a unique payment amount by adding random small decimals.
   * e.g. base $12.50 → $12.534 (3 decimals for exchange compat)
   * parseFloat strips trailing zeros automatically.
   */
  generateUniqueAmount(baseAmount) {
    const suffix = Math.floor(Math.random() * 90 + 10); // 10–99
    return parseFloat((baseAmount + suffix / 1000).toFixed(3));
  },

  /**
   * Make a JSON-RPC call to BSC, with automatic fallback to other nodes.
   */
  async rpcCall(method, params) {
    let lastError;
    for (let attempt = 0; attempt < RPC_ENDPOINTS.length; attempt++) {
      const endpoint = RPC_ENDPOINTS[(currentRpcIndex + attempt) % RPC_ENDPOINTS.length];
      try {
        const { data } = await axios.post(endpoint, {
          jsonrpc: '2.0',
          id: 1,
          method,
          params,
        }, { timeout: 15000 });

        if (data.error) {
          throw new Error(data.error.message || JSON.stringify(data.error));
        }

        return data.result;
      } catch (err) {
        lastError = err;
        logger.warn('BSC RPC call failed, trying next node', {
          endpoint,
          error: err.message,
        });
        currentRpcIndex = (currentRpcIndex + 1) % RPC_ENDPOINTS.length;
      }
    }
    throw lastError;
  },

  /**
   * Fetch recent USDT BEP-20 Transfer events TO our wallet
   * using eth_getLogs on the BSC RPC.
   */
  async getRecentTransfers() {
    const { walletAddress } = config.payment.usdt;
    if (!walletAddress) {
      logger.warn('USDT BEP-20 not configured (missing wallet address)');
      return [];
    }

    try {
      // Get the current block number
      const latestBlockHex = await this.rpcCall('eth_blockNumber', []);
      const latestBlock = parseInt(latestBlockHex, 16);

      // Look back ~200 blocks (~10 minutes at 3s/block)
      const fromBlock = Math.max(0, latestBlock - 200);

      // Pad wallet address to 32 bytes for topic filter (topic2 = "to" address)
      const paddedWallet = '0x' + walletAddress.toLowerCase().replace('0x', '').padStart(64, '0');

      const logs = await this.rpcCall('eth_getLogs', [{
        fromBlock: '0x' + fromBlock.toString(16),
        toBlock: 'latest',
        address: USDT_CONTRACT,
        topics: [
          TRANSFER_TOPIC,  // topic0: Transfer event signature
          null,             // topic1: from (any sender)
          paddedWallet,     // topic2: to (our wallet)
        ],
      }]);

      if (!Array.isArray(logs)) {
        logger.warn('Unexpected eth_getLogs response', { logs });
        return [];
      }

      const transfers = logs.map(log => {
        // The value is in the data field (uint256, 18 decimals for BSC USDT)
        const valueHex = log.data;
        const valueBigInt = BigInt(valueHex);
        const amount = Number(valueBigInt) / 1e18;

        return {
          hash: log.transactionHash,
          from: '0x' + log.topics[1].slice(26), // extract address from padded topic
          amount,
          timestamp: parseInt(log.timeStamp || '0', 16) || Math.floor(Date.now() / 1000),
          blockNumber: parseInt(log.blockNumber, 16),
        };
      });

      if (transfers.length > 0) {
        logger.info('BSC RPC: incoming USDT transfers found', {
          count: transfers.length,
          latestAmount: transfers[transfers.length - 1].amount,
          blockRange: `${fromBlock}-${latestBlock}`,
        });
      }

      return transfers;
    } catch (err) {
      logger.error('BSC RPC error fetching transfers', {
        error: err.message,
      });
      return [];
    }
  },

  /**
   * Check if a specific amount has been received (within tolerance).
   * Returns the matching transaction, or null.
   */
  async findMatchingTransfer(expectedAmount, afterTimestamp) {
    const transfers = await this.getRecentTransfers();
    const tolerance = 0.001; // 0.1 cent tolerance for 3-decimal precision

    for (const tx of transfers) {
      // Skip transfers from before the order was created (using block-based timing)
      // Since RPC logs don't always have timestamps, we rely on the block range filter
      if (Math.abs(tx.amount - expectedAmount) < tolerance) {
        return tx;
      }
    }
    return null;
  },
};

module.exports = UsdtBep20Service;
