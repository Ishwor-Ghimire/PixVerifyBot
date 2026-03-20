const axios = require('axios');
const config = require('../../config');
const logger = require('../../utils/logger');

// USDT contract on BSC (BEP-20)
const USDT_CONTRACT = '0x55d398326f99059fF775485246999027B3197955'.toLowerCase();

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
 * Parse a hex token amount to a float.
 * USDT on BSC has 18 decimals.
 */
function formatTokenAmount(valueHex, decimals = 18) {
  const valueBigInt = BigInt(valueHex);
  const divisor = 10n ** BigInt(decimals);
  const whole = valueBigInt / divisor;
  const fraction = valueBigInt % divisor;
  const fractionText = fraction.toString().padStart(decimals, '0').replace(/0+$/, '');
  return parseFloat(fractionText ? `${whole.toString()}.${fractionText}` : whole.toString());
}

/**
 * USDT BEP-20 payment verification via BSC RPC.
 *
 * Instead of polling eth_getLogs (which is rate-limited on free RPCs),
 * this service verifies payments by transaction hash using
 * eth_getTransactionReceipt — a single-key lookup that works
 * reliably on all free BSC RPC nodes.
 *
 * Flow:
 *   1. User sends USDT to our wallet
 *   2. User submits their tx hash
 *   3. Bot calls eth_getTransactionReceipt to fetch the receipt
 *   4. Parses Transfer event logs to verify recipient + amount
 *   5. Auto-confirms if everything matches
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
          method,
          error: err.message,
        });
        currentRpcIndex = (currentRpcIndex + 1) % RPC_ENDPOINTS.length;
      }
    }
    throw lastError;
  },

  /**
   * Verify a USDT BEP-20 payment by transaction hash.
   *
   * Fetches the transaction receipt from BSC and checks:
   *   - Transaction was successful (status 0x1)
   *   - Contains a Transfer event from the USDT contract
   *   - The "to" address matches our wallet
   *   - The amount matches the expected amount (within tolerance)
   *
   * @param {string} txHash - Transaction hash (0x...)
   * @param {number} expectedAmount - Expected USDT amount
   * @returns {{ verified: boolean, reason?: string, amount?: number, from?: string }}
   */
  async verifyTransaction(txHash, expectedAmount) {
    const { walletAddress } = config.payment.usdt;
    if (!walletAddress) {
      return { verified: false, reason: 'USDT BEP-20 wallet not configured.' };
    }

    const normalizedWallet = walletAddress.toLowerCase();

    // Validate tx hash format
    if (!/^0x[a-fA-F0-9]{64}$/.test(txHash)) {
      return { verified: false, reason: 'Invalid transaction hash format.' };
    }

    try {
      const receipt = await this.rpcCall('eth_getTransactionReceipt', [txHash]);

      if (!receipt) {
        return { verified: false, reason: 'Transaction not found. It may still be pending — please wait a minute and try again.' };
      }

      // Check transaction status (0x1 = success)
      if (receipt.status !== '0x1') {
        return { verified: false, reason: 'Transaction failed on the blockchain.' };
      }

      // Parse logs to find USDT Transfer events to our wallet
      const transferLogs = (receipt.logs || []).filter(log =>
        log.address?.toLowerCase() === USDT_CONTRACT &&
        log.topics?.length >= 3 &&
        log.topics[0] === TRANSFER_TOPIC
      );

      if (transferLogs.length === 0) {
        return { verified: false, reason: 'No USDT transfer found in this transaction.' };
      }

      // Check each Transfer event for a match
      const tolerance = 0.001; // strict: must match within 0.001 USDT
      for (const log of transferLogs) {
        const toAddress = '0x' + log.topics[2].slice(26).toLowerCase();
        const amount = formatTokenAmount(log.data);

        if (toAddress === normalizedWallet) {
          const diff = Math.abs(amount - expectedAmount);
          if (diff <= tolerance) {
            const fromAddress = '0x' + log.topics[1].slice(26).toLowerCase();
            logger.info('BEP-20 tx hash verified', {
              txHash,
              amount,
              expectedAmount,
              from: fromAddress,
            });
            return {
              verified: true,
              amount,
              from: fromAddress,
              hash: txHash,
            };
          } else {
            logger.warn('BEP-20 tx amount mismatch', {
              txHash,
              amount,
              expectedAmount,
              diff,
            });
            return {
              verified: false,
              reason: `Amount mismatch: transaction sent ${amount} USDT but expected ${expectedAmount} USDT. Please send the exact amount.`,
            };
          }
        }
      }

      return { verified: false, reason: 'This transaction was not sent to our wallet address.' };
    } catch (err) {
      logger.error('BEP-20 tx verification error', { txHash, error: err.message });
      return { verified: false, reason: 'Could not verify transaction. Please try again in a moment.' };
    }
  },
};

module.exports = UsdtBep20Service;
