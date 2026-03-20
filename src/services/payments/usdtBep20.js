const axios = require('axios');
const config = require('../../config');
const logger = require('../../utils/logger');

// USDT contract on BSC (BEP-20)
const USDT_CONTRACT = '0x55d398326f99059fF775485246999027B3197955';
const USDT_CONTRACT_LOWER = USDT_CONTRACT.toLowerCase();

// Transfer(address,address,uint256) event topic
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

// RPC endpoints that support eth_getLogs without rate limiting.
// PublicNode and 1rpc are used for log queries (Binance RPCs rate-limit eth_getLogs).
// Binance RPCs are kept as fallback for simple calls (eth_blockNumber, etc).
const LOG_RPC_ENDPOINTS = [
  'https://bsc-rpc.publicnode.com',
  'https://1rpc.io/bnb',
];

const FALLBACK_RPC_ENDPOINTS = [
  'https://bsc-dataseed1.binance.org',
  'https://bsc-dataseed2.binance.org',
  'https://bsc-dataseed3.binance.org',
  'https://bsc-dataseed4.binance.org',
];

const BSC_AVERAGE_BLOCK_TIME_SECONDS = 3;
const MIN_LOOKBACK_BLOCKS = 200;
const BLOCK_LOOKBACK_BUFFER = 120;
const MAX_BLOCKS_PER_LOG_QUERY = 2000;

let currentLogRpcIndex = 0;
let currentFallbackRpcIndex = 0;
const blockTimestampCache = new Map();

/**
 * Parse a hex token amount to a float (USDT on BSC = 18 decimals).
 */
function formatTokenAmount(valueHex, decimals = 18) {
  const valueBigInt = BigInt(valueHex);
  const divisor = 10n ** BigInt(decimals);
  const whole = valueBigInt / divisor;
  const fraction = valueBigInt % divisor;
  const fractionText = fraction.toString().padStart(decimals, '0').replace(/0+$/, '');
  return parseFloat(fractionText ? `${whole.toString()}.${fractionText}` : whole.toString());
}

function hexToNumber(value) {
  if (!value) return 0;
  return parseInt(value, 16);
}

/**
 * USDT BEP-20 fully automatic payment detection.
 *
 * Background monitor polls eth_getLogs via free BSC RPC nodes (PublicNode, 1rpc)
 * that don't rate-limit log queries. When the user clicks "I've Paid", an
 * immediate on-chain scan is triggered instead of waiting for the next poll.
 *
 * Anti-fraud: duplicate transfers are prevented by checking payment_reference
 * in the database before confirming (handled by the caller).
 */
const UsdtBep20Service = {
  /**
   * Generate a unique payment amount by adding random small decimals.
   * e.g. base $12.50 → $12.534
   */
  generateUniqueAmount(baseAmount) {
    const suffix = Math.floor(Math.random() * 90 + 10); // 10–99
    return parseFloat((baseAmount + suffix / 1000).toFixed(3));
  },

  /**
   * JSON-RPC call with fallback across multiple endpoints.
   * @param {string} method - RPC method
   * @param {Array} params - RPC params
   * @param {boolean} useLogEndpoints - Use log-friendly endpoints for eth_getLogs
   */
  async rpcCall(method, params, useLogEndpoints = false) {
    const endpoints = useLogEndpoints ? LOG_RPC_ENDPOINTS : [...LOG_RPC_ENDPOINTS, ...FALLBACK_RPC_ENDPOINTS];
    let lastError;
    const startIndex = useLogEndpoints ? currentLogRpcIndex : currentFallbackRpcIndex;

    for (let attempt = 0; attempt < endpoints.length; attempt++) {
      const idx = (startIndex + attempt) % endpoints.length;
      const endpoint = endpoints[idx];
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
          method,
          error: err.message,
        });
        if (useLogEndpoints) {
          currentLogRpcIndex = (currentLogRpcIndex + 1) % LOG_RPC_ENDPOINTS.length;
        } else {
          currentFallbackRpcIndex = (currentFallbackRpcIndex + 1) % endpoints.length;
        }
      }
    }
    throw lastError;
  },

  /**
   * Fetch a block timestamp and cache it.
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

    // Keep cache small
    if (blockTimestampCache.size > 500) {
      const oldest = blockTimestampCache.keys().next().value;
      blockTimestampCache.delete(oldest);
    }

    return timestamp;
  },

  /**
   * Fetch recent USDT BEP-20 Transfer events TO our wallet.
   * Uses log-friendly RPC endpoints that support eth_getLogs.
   */
  async getRecentTransfers(afterTimestamp = null) {
    const { walletAddress } = config.payment.usdt;
    if (!walletAddress) {
      logger.warn('USDT BEP-20 not configured (missing wallet address)');
      return [];
    }

    try {
      const latestBlockHex = await this.rpcCall('eth_blockNumber', []);
      const latestBlock = hexToNumber(latestBlockHex);
      const latestTimestamp = await this.getBlockTimestamp(latestBlock);

      let effectiveAfterTimestamp = Number.isFinite(afterTimestamp)
        ? Math.floor(afterTimestamp)
        : latestTimestamp - (MIN_LOOKBACK_BLOCKS * BSC_AVERAGE_BLOCK_TIME_SECONDS);

      const secondsBack = Math.max(0, latestTimestamp - effectiveAfterTimestamp);
      const blocksBack = Math.max(
        MIN_LOOKBACK_BLOCKS,
        Math.ceil(secondsBack / BSC_AVERAGE_BLOCK_TIME_SECONDS) + BLOCK_LOOKBACK_BUFFER
      );
      const fromBlock = Math.max(0, latestBlock - blocksBack);

      // Pad wallet address for topic filter (topic2 = "to" address)
      const paddedWallet = '0x' + walletAddress.toLowerCase().replace('0x', '').padStart(64, '0');

      const logs = [];
      for (let batchFrom = fromBlock; batchFrom <= latestBlock; batchFrom += MAX_BLOCKS_PER_LOG_QUERY) {
        const batchTo = Math.min(latestBlock, batchFrom + MAX_BLOCKS_PER_LOG_QUERY - 1);

        // Use log-friendly endpoints for eth_getLogs
        const batchLogs = await this.rpcCall('eth_getLogs', [{
          fromBlock: `0x${batchFrom.toString(16)}`,
          toBlock: `0x${batchTo.toString(16)}`,
          address: USDT_CONTRACT,
          topics: [
            TRANSFER_TOPIC,
            null,
            paddedWallet,
          ],
        }], true);

        if (!Array.isArray(batchLogs)) {
          logger.warn('Unexpected eth_getLogs response', { batchFrom, batchTo, batchLogs });
          continue;
        }

        logs.push(...batchLogs);
      }

      // Resolve block timestamps
      const blockNumbers = [...new Set(logs.map(log => hexToNumber(log.blockNumber)).filter(Boolean))];
      const blockTimestamps = new Map();
      for (const blockNumber of blockNumbers) {
        blockTimestamps.set(blockNumber, await this.getBlockTimestamp(blockNumber));
      }

      const transfers = logs.map(log => {
        const blockNumber = hexToNumber(log.blockNumber);
        return {
          hash: log.transactionHash,
          from: '0x' + log.topics[1].slice(26),
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
        });
      }

      return transfers;
    } catch (err) {
      logger.error('BSC RPC error fetching transfers', { error: err.message });
      return [];
    }
  },

  /**
   * Find a matching transfer for the expected amount (within tolerance).
   * @param {number} expectedAmount - The unique amount to match
   * @param {number} afterTimestamp - Only consider transfers after this time
   * @param {Set<string>} [excludeHashes] - Tx hashes to skip (already used by other orders)
   * @returns {object|null} The matching transaction, or null
   */
  async findMatchingTransfer(expectedAmount, afterTimestamp, excludeHashes = null) {
    const normalizedAfterTimestamp = Number.isFinite(afterTimestamp) ? Math.floor(afterTimestamp) : null;
    const transfers = await this.getRecentTransfers(normalizedAfterTimestamp);
    const tolerance = 0.0005; // Half the 0.001 step size — prevents adjacent amount overlap

    if (transfers.length > 0) {
      logger.info('BEP-20 findMatchingTransfer comparing', {
        expectedAmount,
        tolerance,
        transferCount: transfers.length,
        transferAmounts: transfers.slice(0, 10).map(t => t.amount),
      });
    }

    for (const tx of transfers) {
      if (normalizedAfterTimestamp && tx.timestamp < normalizedAfterTimestamp) {
        continue;
      }
      if (excludeHashes && excludeHashes.has(tx.hash)) {
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
