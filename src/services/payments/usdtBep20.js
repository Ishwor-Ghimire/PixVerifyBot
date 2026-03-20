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

const ADDRESS_PATTERN = /^0x[a-fA-F0-9]{40}$/;
const BSC_AVERAGE_BLOCK_TIME_SECONDS = 3;
const MIN_LOOKBACK_BLOCKS = 200;
const BLOCK_LOOKBACK_BUFFER = 120;
const MAX_BLOCKS_PER_LOG_QUERY = 2500;
const MAX_LOOKBACK_SECONDS = Math.max((config.payment.orderExpiryMinutes || 60) * 60 * 4, 24 * 60 * 60);

let currentRpcIndex = 0;
const blockTimestampCache = new Map();

function isValidBscAddress(address) {
  return ADDRESS_PATTERN.test((address || '').trim());
}

function hexToNumber(value) {
  if (!value) return 0;
  return parseInt(value, 16);
}

function formatTokenAmount(valueHex, decimals = 18) {
  const valueBigInt = BigInt(valueHex);
  const divisor = 10n ** BigInt(decimals);
  const whole = valueBigInt / divisor;
  const fraction = valueBigInt % divisor;
  const fractionText = fraction.toString().padStart(decimals, '0').replace(/0+$/, '');
  return parseFloat(fractionText ? `${whole.toString()}.${fractionText}` : whole.toString());
}

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
   * Fetch a block timestamp and cache it for later comparisons.
   */
  async getBlockTimestamp(blockNumber) {
    if (blockTimestampCache.has(blockNumber)) {
      return blockTimestampCache.get(blockNumber);
    }

    const block = await this.rpcCall('eth_getBlockByNumber', [
      `0x${blockNumber.toString(16)}`,
      false,
    ]);

    if (!block || !block.timestamp) {
      throw new Error(`Missing block data for ${blockNumber}`);
    }

    const timestamp = hexToNumber(block.timestamp);
    blockTimestampCache.set(blockNumber, timestamp);
    return timestamp;
  },

  /**
   * Fetch recent USDT BEP-20 Transfer events TO our wallet
   * using eth_getLogs on the BSC RPC.
   */
  async getRecentTransfers(afterTimestamp = null) {
    const { walletAddress } = config.payment.usdt;
    if (!walletAddress) {
      logger.warn('USDT BEP-20 not configured (missing wallet address)');
      return [];
    }
    if (!isValidBscAddress(walletAddress)) {
      logger.warn('USDT BEP-20 not configured (invalid wallet address)', { walletAddress });
      return [];
    }

    try {
      // Get the current block number
      const latestBlockHex = await this.rpcCall('eth_blockNumber', []);
      const latestBlock = hexToNumber(latestBlockHex);
      const latestTimestamp = await this.getBlockTimestamp(latestBlock);

      let effectiveAfterTimestamp = Number.isFinite(afterTimestamp)
        ? Math.floor(afterTimestamp)
        : latestTimestamp - (MIN_LOOKBACK_BLOCKS * BSC_AVERAGE_BLOCK_TIME_SECONDS);

      const earliestAllowedTimestamp = Math.max(0, latestTimestamp - MAX_LOOKBACK_SECONDS);
      if (effectiveAfterTimestamp < earliestAllowedTimestamp) {
        logger.warn('BEP-20 order is older than RPC search window, limiting log lookup', {
          requestedAfterTimestamp: effectiveAfterTimestamp,
          effectiveAfterTimestamp: earliestAllowedTimestamp,
          maxLookbackSeconds: MAX_LOOKBACK_SECONDS,
        });
        effectiveAfterTimestamp = earliestAllowedTimestamp;
      }

      const secondsBack = Math.max(0, latestTimestamp - effectiveAfterTimestamp);
      const blocksBack = Math.max(
        MIN_LOOKBACK_BLOCKS,
        Math.ceil(secondsBack / BSC_AVERAGE_BLOCK_TIME_SECONDS) + BLOCK_LOOKBACK_BUFFER
      );
      const fromBlock = Math.max(0, latestBlock - blocksBack);

      // Pad wallet address to 32 bytes for topic filter (topic2 = "to" address)
      const paddedWallet = '0x' + walletAddress.toLowerCase().replace('0x', '').padStart(64, '0');

      const logs = [];
      for (let batchFrom = fromBlock; batchFrom <= latestBlock; batchFrom += MAX_BLOCKS_PER_LOG_QUERY) {
        const batchTo = Math.min(latestBlock, batchFrom + MAX_BLOCKS_PER_LOG_QUERY - 1);
        const batchLogs = await this.rpcCall('eth_getLogs', [{
          fromBlock: `0x${batchFrom.toString(16)}`,
          toBlock: `0x${batchTo.toString(16)}`,
          address: USDT_CONTRACT,
          topics: [
            TRANSFER_TOPIC,
            null,
            paddedWallet,
          ],
        }]);

        if (!Array.isArray(batchLogs)) {
          logger.warn('Unexpected eth_getLogs response', { batchFrom, batchTo, batchLogs });
          continue;
        }

        logs.push(...batchLogs);
      }

      const blockNumbers = [...new Set(logs.map(log => hexToNumber(log.blockNumber)).filter(Boolean))];
      const blockTimestamps = new Map();
      for (const blockNumber of blockNumbers) {
        blockTimestamps.set(blockNumber, await this.getBlockTimestamp(blockNumber));
      }

      const transfers = logs.map(log => {
        const blockNumber = hexToNumber(log.blockNumber);

        return {
          hash: log.transactionHash,
          from: '0x' + log.topics[1].slice(26), // extract address from padded topic
          amount: formatTokenAmount(log.data),
          timestamp: blockTimestamps.get(blockNumber) || latestTimestamp,
          blockNumber,
        };
      }).filter(tx => tx.timestamp >= effectiveAfterTimestamp)
        .sort((a, b) => a.blockNumber - b.blockNumber);

      if (transfers.length > 0) {
        logger.info('BSC RPC: incoming USDT transfers found', {
          count: transfers.length,
          latestAmount: transfers[transfers.length - 1].amount,
          blockRange: `${fromBlock}-${latestBlock}`,
          afterTimestamp: effectiveAfterTimestamp,
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
    const normalizedAfterTimestamp = Number.isFinite(afterTimestamp) ? Math.floor(afterTimestamp) : null;
    const transfers = await this.getRecentTransfers(normalizedAfterTimestamp);
    const tolerance = 0.001;

    if (transfers.length > 0) {
      logger.info('BEP-20 findMatchingTransfer comparing', {
        expectedAmount,
        tolerance,
        afterTimestamp: normalizedAfterTimestamp,
        transferCount: transfers.length,
        transferAmounts: transfers.slice(0, 10).map(t => t.amount),
      });
    }

    for (const tx of transfers) {
      if (normalizedAfterTimestamp && tx.timestamp < normalizedAfterTimestamp) {
        continue;
      }

      const diff = Math.abs(tx.amount - expectedAmount);
      if (diff < tolerance) {
        logger.info('BEP-20 MATCH found', { txHash: tx.hash, txAmount: tx.amount, expectedAmount, diff });
        return tx;
      }
    }
    return null;
  },
};

module.exports = UsdtBep20Service;
