const config = require('../../config');
const PaymentService = require('../../services/paymentService');
const UsdtBep20Service = require('../../services/payments/usdtBep20');
const BinanceApiClient = require('../../services/payments/binancePay');
const User = require('../../db/models/User');
const { MESSAGES, CALLBACKS } = require('../../utils/constants');
const { escapeMarkdownV1 } = require('../../utils/helpers');
const logger = require('../../utils/logger');

// Track users waiting to submit Binance order IDs
const pendingVerifications = new Map();

function register(bot) {
  // /buy command — show credit packages
  bot.onText(/\/buy/, async (msg) => {
    const packages = config.credits.packages;
    const buttons = packages.map((pkg, i) => {
      const perCredit = (parseFloat(pkg.price) / pkg.credits).toFixed(2);
      const discount = pkg.credits > 1 ? ` ($${perCredit}/ea)` : '';
      return [{
        text: `${pkg.label} · ${pkg.credits} credit${pkg.credits > 1 ? 's' : ''} — $${pkg.price}${discount}`,
        callback_data: `${CALLBACKS.BUY_PACKAGE}${i}`,
      }];
    });

    const priceNote = `\n💵 *$${config.credits.priceUsd} per credit*`;

    await bot.sendMessage(msg.chat.id, MESSAGES.BUY_HEADER + priceNote, {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: buttons },
    });
  });

  // Handle package selection → show payment methods
  bot.on('callback_query', async (query) => {
    if (!query.data?.startsWith(CALLBACKS.BUY_PACKAGE)) return;

    const pkgIndex = parseInt(query.data.replace(CALLBACKS.BUY_PACKAGE, ''), 10);
    const packages = config.credits.packages;

    if (pkgIndex < 0 || pkgIndex >= packages.length) {
      return bot.answerCallbackQuery(query.id, { text: 'Invalid package' });
    }

    await bot.answerCallbackQuery(query.id);

    const methods = PaymentService.getAvailableMethods();

    if (methods.length === 0) {
      return bot.sendMessage(query.message.chat.id,
        '⚠️ No payment methods are configured yet. Please contact support.',
      );
    }

    const buttons = methods.map(m => ([{
      text: m.label,
      callback_data: `${CALLBACKS.PAY_METHOD}${pkgIndex}_${m.id}`,
    }]));

    buttons.push([{ text: '❌ Cancel', callback_data: CALLBACKS.PAY_CANCEL }]);

    const pkg = packages[pkgIndex];
    await bot.sendMessage(query.message.chat.id, [
      '💳 *Select Payment Method*',
      '',
      `Package: *${pkg.label}*`,
      `Amount: *$${pkg.price} USDT*`,
    ].join('\n'), {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: buttons },
    });
  });

  // Handle payment method selection
  bot.on('callback_query', async (query) => {
    if (!query.data?.startsWith(CALLBACKS.PAY_METHOD)) return;

    const parts = query.data.replace(CALLBACKS.PAY_METHOD, '').split('_');
    const pkgIndex = parseInt(parts[0], 10);
    const methodId = parts.slice(1).join('_');
    const packages = config.credits.packages;

    if (pkgIndex < 0 || pkgIndex >= packages.length) {
      return bot.answerCallbackQuery(query.id, { text: 'Invalid selection' });
    }

    await bot.answerCallbackQuery(query.id);
    const pkg = packages[pkgIndex];
    const chatId = query.message.chat.id;
    const userId = query.from.id;

    try {
      await bot.editMessageReplyMarkup(
        { inline_keyboard: [] },
        { chat_id: chatId, message_id: query.message.message_id }
      );
    } catch { }

    if (methodId === 'usdt_bep20') {
      await handleUsdtPayment(bot, chatId, userId, pkg);
    } else if (methodId === 'usdt_trc20') {
      await handleUsdtTrc20Payment(bot, chatId, userId, pkg);
    } else if (methodId === 'binance_transfer') {
      await handleBinanceTransfer(bot, chatId, userId, pkg);
    }
  });

  // Handle "I've Paid" button for BEP20 — instant on-chain scan (no tx hash needed)
  bot.on('callback_query', async (query) => {
    if (!query.data?.startsWith(CALLBACKS.CRYPTO_PAID)) return;

    const payload = query.data.replace(CALLBACKS.CRYPTO_PAID, '');
    const firstUnderscore = payload.indexOf('_');
    const orderId = parseInt(payload.substring(0, firstUnderscore), 10);
    const method = payload.substring(firstUnderscore + 1);
    const userId = query.from.id;
    const chatId = query.message.chat.id;

    await bot.answerCallbackQuery(query.id);

    if (method === 'usdt_bep20') {
      await handleBep20IvePaid(bot, chatId, userId, orderId, query.message.message_id);
    } else if (method === 'usdt_trc20') {
      await handleTrc20IvePaid(bot, chatId, userId, orderId);
    } else if (method === 'binance_transfer') {
      await handleBinanceIvePaid(bot, chatId, userId, orderId, query.message.message_id);
    }
  });

  // Handle "I've paid" button for Binance Transfer
  bot.on('callback_query', async (query) => {
    if (!query.data?.startsWith(CALLBACKS.BINANCE_PAID)) return;

    const orderId = parseInt(query.data.replace(CALLBACKS.BINANCE_PAID, ''), 10);
    const userId = query.from.id;

    await bot.answerCallbackQuery(query.id);

    // Store that this user needs to submit a transaction ID
    pendingVerifications.set(userId, { orderId, chatId: query.message.chat.id, method: 'binance_transfer' });

    // Auto-expire after 30 minutes
    setTimeout(() => pendingVerifications.delete(userId), 30 * 60 * 1000);

    await bot.sendMessage(query.message.chat.id, [
      '🔍 *Payment Verification*',
      '',
      `📋 Order #${orderId}`,
      '',
      'Please send your *Binance Pay Order (Transaction) ID* now.',
      '',
      '_You can find it in: Binance App → Pay → Transaction History → tap the transaction → copy the Order ID_',
    ].join('\n'), { parse_mode: 'Markdown' });
  });

  // Listen for Binance order/transaction ID submission from users
  bot.on('message', async (msg) => {
    if (!msg.text || msg.text.startsWith('/')) return;

    const userId = msg.from.id;
    const pending = pendingVerifications.get(userId);
    if (!pending) return;

    const submittedId = msg.text.trim();

    // Basic validation
    if (submittedId.length < 5) {
      return bot.sendMessage(msg.chat.id, '⚠️ That doesn\'t look like a valid Transaction ID. Please try again.');
    }

    pendingVerifications.delete(userId);

    // Check if the order is still pending before proceeding
    const Purchase = require('../../db/models/Purchase');
    const purchase = Purchase.getById(pending.orderId);
    if (!purchase || purchase.payment_status !== 'pending') {
      const statusMsg = purchase?.payment_status === 'completed'
        ? '✅ This order has already been confirmed automatically. No action needed!'
        : '⚠️ This order is no longer pending.';
      return bot.sendMessage(msg.chat.id, statusMsg);
    }

    // Save the transaction ID as payment reference on the order
    try {
      Purchase.updateStatusIfPending(pending.orderId, {
        paymentStatus: 'pending', // keep pending for admin
        paymentReference: `binance_txid_${submittedId}`,
      });
    } catch (e) {
      logger.error('Error saving payment reference', { error: e.message });
    }

    // Tell the user to wait
    await bot.sendMessage(msg.chat.id, [
      '✅ *Payment Submitted!*',
      '',
      `📋 Order #${pending.orderId}`,
      `🔖 Transaction ID: \`${submittedId}\``,
      '',
      '⏳ Please wait for an admin to verify and confirm your payment.',
      'You will be notified once your credits are added.',
      '',
      '_This usually takes a few minutes._',
    ].join('\n'), { parse_mode: 'Markdown' });

    // Notify all admins
    const adminIds = config.admin.userIds;
    const username = msg.from.username ? `@${escapeMarkdownV1(msg.from.username)}` : `ID:${userId}`;

    for (const adminId of adminIds) {
      try {
        await bot.sendMessage(adminId, [
          '🔔 *New Binance Pay Payment Submitted*',
          '',
          `👤 User: ${username} (ID: \`${userId}\`)`,
          `📋 Order: #${pending.orderId}`,
          `🔖 Transaction ID: \`${submittedId}\``,
          '',
          'Please verify this payment in your Binance app and then confirm or reject below.',
        ].join('\n'), {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [
                { text: '✅ Confirm Payment', callback_data: `${CALLBACKS.ADMIN_CONFIRM}${pending.orderId}` },
                { text: '❌ Reject', callback_data: `${CALLBACKS.ADMIN_REJECT}${pending.orderId}` },
              ],
            ],
          },
        });
      } catch (e) {
        logger.error('Failed to notify admin', { adminId, error: e.message });
      }
    }

    logger.info('Binance payment submitted for admin review', {
      orderId: pending.orderId,
      userId,
      transactionId: submittedId,
    });
  });

  // Handle pay cancel
  bot.on('callback_query', async (query) => {
    if (query.data !== CALLBACKS.PAY_CANCEL) return;
    await bot.answerCallbackQuery(query.id, { text: 'Cancelled' });
    pendingVerifications.delete(query.from.id);
    try {
      await bot.editMessageText('🚫 Purchase cancelled.', {
        chat_id: query.message.chat.id,
        message_id: query.message.message_id,
      });
    } catch { }
  });
}

/**
 * Handle BEP-20 "I've Paid" — instant on-chain scan, no tx hash needed.
 */
async function handleBep20IvePaid(bot, chatId, userId, orderId, messageId) {
  const Purchase = require('../../db/models/Purchase');
  const purchase = Purchase.getById(orderId);

  if (!purchase || purchase.payment_status !== 'pending') {
    return bot.sendMessage(chatId, '⚠️ This order is no longer pending.');
  }
  if (purchase.telegram_user_id !== userId) {
    return bot.sendMessage(chatId, '⚠️ This order does not belong to you.');
  }

  await bot.sendMessage(chatId, '⏳ Scanning the blockchain for your payment...');

  const expectedAmount = parseFloat(purchase.unique_amount);
  const createdAtUtc = purchase.created_at.endsWith('Z') ? purchase.created_at : purchase.created_at.replace(' ', 'T') + 'Z';
  const orderTimestamp = Math.floor(new Date(createdAtUtc).getTime() / 1000) - 60;

  // Pass used hashes so the matcher skips them and finds the next valid transfer
  const usedHashes = Purchase.getUsedPaymentReferences();
  const tx = await UsdtBep20Service.findMatchingTransfer(expectedAmount, orderTimestamp, usedHashes);

  if (!tx) {
    return bot.sendMessage(chatId, [
      '⏳ *Payment Not Found Yet*',
      '',
      `📋 Order #${orderId}`,
      `💰 Expected: \`${expectedAmount}\` USDT`,
      '',
      'Your transaction may still be confirming on the blockchain.',
      'Please wait 1-2 minutes and tap *"I\'ve Paid"* again, or the system will auto-detect it shortly.',
    ].join('\n'), { parse_mode: 'Markdown' });
  }

  // Auto-confirm!
  const confirmation = PaymentService.confirmPayment(orderId, tx.hash);
  if (confirmation.success) {
    // Remove the "I've Paid" buttons from original message
    try {
      await bot.editMessageReplyMarkup(
        { inline_keyboard: [] },
        { chat_id: chatId, message_id: messageId }
      );
    } catch { }

    await bot.sendMessage(chatId, [
      '✅ *Payment Confirmed!*',
      '',
      `💰 *${purchase.credits_added} credits* added to your balance.`,
      `📋 Order #${orderId}`,
      '',
      'Use /run to generate a link or /balance to check your balance.',
    ].join('\n'), { parse_mode: 'Markdown' });

    // Notify referrer if they earned a reward
    if (confirmation.referrerRewarded) {
      try {
        const referrerBalance = User.getBalance(confirmation.referrerRewarded);
        const rewardMsg = MESSAGES.REFERRAL_REWARD_NOTIFY
          .replace('{reward}', config.referral.rewardCredits)
          .replace('{balance}', referrerBalance);
        await bot.sendMessage(confirmation.referrerRewarded, rewardMsg, {
          parse_mode: 'Markdown',
        });
      } catch (err) {
        logger.warn('Could not notify referrer of reward', {
          referrerId: confirmation.referrerRewarded,
          error: err.message,
        });
      }
    }

    logger.info('BEP-20 payment confirmed via I\'ve Paid scan', {
      orderId,
      txHash: tx.hash,
      amount: tx.amount,
      userId,
    });
  } else {
    await bot.sendMessage(chatId, `⚠️ ${confirmation.error || 'Could not confirm order.'}`);
  }
}

/**
 * Handle TRC-20 "I've Paid" — submit for admin review
 */
async function handleTrc20IvePaid(bot, chatId, userId, orderId) {
  const Purchase = require('../../db/models/Purchase');
  const purchase = Purchase.getById(orderId);

  if (!purchase || purchase.payment_status !== 'pending') {
    return bot.sendMessage(chatId, '⚠️ This order is no longer pending.');
  }

  await bot.sendMessage(chatId, [
    '✅ *Payment Noted!*',
    '',
    `📋 Order #${orderId}`,
    '',
    '⏳ The system will automatically detect your TRC-20 payment shortly.',
    'If it takes more than a few minutes, an admin will verify manually.',
  ].join('\n'), { parse_mode: 'Markdown' });
}

/**
 * Handle USDT BEP-20 payment flow
 */
async function handleUsdtPayment(bot, chatId, userId, pkg) {
  const order = PaymentService.createUsdtOrder(userId, pkg);
  if (order.error) {
    return bot.sendMessage(chatId, `⚠️ ${order.message || 'Could not create order. Please try again.'}`);
  }

  const msg = [
    '💎 *USDT (BEP-20) Payment*',
    '',
    `📋 Order #${order.orderId}`,
    `📦 Package: *${pkg.label}*`,
    '',
    `💰 Send exactly: *\`${parseFloat(order.uniqueAmount.toFixed(3))}\` USDT*`,
    '',
    '📬 *To this address (BEP-20 / BSC network):*',
    `\`${order.walletAddress}\``,
    '',
    '⚠️ *Important:*',
    '• Send the *exact amount* shown above',
    '• Use only the *BSC (BEP-20)* network',
    '• After sending, tap *"I\'ve Paid"* below or wait for automatic detection',
    '',
    '⏱️ This order expires in 15 minutes.',
  ].join('\n');

  await bot.sendMessage(chatId, msg, {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [{ text: '✅ I\'ve Paid', callback_data: `${CALLBACKS.CRYPTO_PAID}${order.orderId}_usdt_bep20` }],
        [{ text: '❌ Cancel', callback_data: CALLBACKS.PAY_CANCEL }],
      ],
    },
  });
}

/**
 * Handle USDT TRC-20 payment flow
 */
async function handleUsdtTrc20Payment(bot, chatId, userId, pkg) {
  const order = PaymentService.createUsdtTrc20Order(userId, pkg);
  if (order.error) {
    return bot.sendMessage(chatId, `⚠️ ${order.message || 'Could not create order. Please try again.'}`);
  }

  const msg = [
    '🟥 *USDT (TRC-20) Payment*',
    '',
    `📋 Order #${order.orderId}`,
    `📦 Package: *${pkg.label}*`,
    '',
    `💰 Send exactly: *\`${parseFloat(order.uniqueAmount.toFixed(3))}\` USDT*`,
    '',
    '📬 *To this address (TRC-20 / Tron network):*',
    `\`${order.walletAddress}\``,
    '',
    '⚠️ *Important:*',
    '• Send the *exact amount* shown above',
    '• Use only the *TRON (TRC-20)* network',
    '• After sending, tap *"I\'ve Paid"* below or wait for automatic detection',
    '',
    '⏱️ This order expires in 15 minutes.',
  ].join('\n');

  await bot.sendMessage(chatId, msg, {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [{ text: '✅ I\'ve Paid', callback_data: `${CALLBACKS.CRYPTO_PAID}${order.orderId}_usdt_trc20` }],
        [{ text: '❌ Cancel', callback_data: CALLBACKS.PAY_CANCEL }],
      ],
    },
  });
}

/**
 * Handle Binance Transfer payment flow.
 * Now shows a unique amount for auto-detection via deposit history API.
 */
async function handleBinanceTransfer(bot, chatId, userId, pkg) {
  const order = PaymentService.createBinanceTransferOrder(userId, pkg);

  // Handle order creation errors (e.g. amount collision)
  if (order.error) {
    return bot.sendMessage(chatId, `⚠️ ${order.message || 'Could not create order. Please try again.'}`);
  }

  const uniqueAmountStr = parseFloat(order.uniqueAmount.toFixed(3));

  const msg = [
    '🟡 *Binance Pay Payment*',
    '',
    `📋 Order #${order.orderId}`,
    `📦 Package: *${pkg.label}*`,
    '',
    `💰 Send exactly: *\`${uniqueAmountStr}\` USDT*`,
    '',
    '📬 *Send USDT via Binance Pay to:*',
    `Pay ID: \`${order.binancePayId}\``,
    '',
    '📝 *Steps:*',
    '1. Open *Binance App* → *Pay* → *Send*',
    '2. Enter the Pay ID above',
    `3. Send exactly *\`${uniqueAmountStr}\` USDT*`,
    config.payment.binanceTransfer.autoVerifyEnabled
      ? '4. After sending, tap *"I\'ve Paid"* below or wait for automatic detection'
      : '4. After sending, tap *"I\'ve Paid"* below and submit your Transaction ID',
    '',
    '⏱️ This order expires in 30 minutes.',
  ].join('\n');

  await bot.sendMessage(chatId, msg, {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [{ text: '✅ I\'ve Paid', callback_data: `${CALLBACKS.CRYPTO_PAID}${order.orderId}_binance_transfer` }],
        [{ text: '❌ Cancel', callback_data: CALLBACKS.PAY_CANCEL }],
      ],
    },
  });
}

/**
 * Handle Binance Pay "I've Paid" — try auto-scan via deposit history,
 * fall back to manual TX ID + admin review if deposit not found.
 */
async function handleBinanceIvePaid(bot, chatId, userId, orderId, messageId) {
  const Purchase = require('../../db/models/Purchase');
  const purchase = Purchase.getById(orderId);

  if (!purchase || purchase.payment_status !== 'pending') {
    return bot.sendMessage(chatId, '⚠️ This order is no longer pending.');
  }
  if (purchase.telegram_user_id !== userId) {
    return bot.sendMessage(chatId, '⚠️ This order does not belong to you.');
  }

  // Only attempt auto-scan if API credentials are configured
  if (BinanceApiClient.isConfigured()) {
    await bot.sendMessage(chatId, '⏳ Scanning Binance deposit history for your payment...');

    const expectedAmount = parseFloat(purchase.unique_amount);
    const createdAtUtc = purchase.created_at.endsWith('Z') ? purchase.created_at : purchase.created_at.replace(' ', 'T') + 'Z';
    const orderTimestampMs = new Date(createdAtUtc).getTime() - 60000;

    const usedRefs = Purchase.getUsedPaymentReferences();
    const deposit = await BinanceApiClient.findMatchingDeposit(expectedAmount, orderTimestampMs, usedRefs);

    if (deposit) {
      // Auto-confirm!
      const reference = `binance_deposit_${deposit.txId}`;
      const confirmation = PaymentService.confirmPayment(orderId, reference);

      // Clear any pending manual verification for this user
      pendingVerifications.delete(userId);

      if (confirmation.success) {
        try {
          await bot.editMessageReplyMarkup(
            { inline_keyboard: [] },
            { chat_id: chatId, message_id: messageId }
          );
        } catch { }

        await bot.sendMessage(chatId, [
          '✅ *Payment Confirmed!*',
          '',
          `💰 *${purchase.credits_added} credits* added to your balance.`,
          `📋 Order #${orderId}`,
          '',
          'Use /run to generate a link or /balance to check your balance.',
        ].join('\n'), { parse_mode: 'Markdown' });

        // Notify referrer if they earned a reward
        if (confirmation.referrerRewarded) {
          try {
            const referrerBalance = User.getBalance(confirmation.referrerRewarded);
            const rewardMsg = MESSAGES.REFERRAL_REWARD_NOTIFY
              .replace('{reward}', config.referral.rewardCredits)
              .replace('{balance}', referrerBalance);
            await bot.sendMessage(confirmation.referrerRewarded, rewardMsg, {
              parse_mode: 'Markdown',
            });
          } catch (err) {
            logger.warn('Could not notify referrer of reward', {
              referrerId: confirmation.referrerRewarded,
              error: err.message,
            });
          }
        }

        logger.info('Binance deposit confirmed via I\'ve Paid scan', {
          orderId,
          txId: deposit.txId,
          amount: deposit.amount,
          userId,
        });
        return;
      } else if (confirmation.error === 'Already confirmed') {
        // Race: monitor confirmed it between our scan and confirm call
        await bot.sendMessage(chatId, '✅ Your payment has already been confirmed! Check /balance.');
        return;
      } else {
        await bot.sendMessage(chatId, `⚠️ ${confirmation.error || 'Could not confirm order.'}`);
        return;
      }
    }
  }

  // Auto-scan failed or not configured → fall back to manual TX ID submission
  pendingVerifications.set(userId, { orderId, chatId, method: 'binance_transfer' });
  setTimeout(() => pendingVerifications.delete(userId), 30 * 60 * 1000);

  const fallbackLines = [
    '⏳ *Deposit Not Detected Yet*',
    '',
    `📋 Order #${orderId}`,
    '',
  ];

  if (config.payment.binanceTransfer.autoVerifyEnabled) {
    fallbackLines.push(
      'The deposit may still be processing. You can either:',
      '• *Wait* — the system checks automatically every 15 seconds',
      '• *Submit your Transaction ID* manually for admin review',
    );
  } else {
    fallbackLines.push(
      'Please submit your *Transaction ID* for admin review.',
    );
  }

  fallbackLines.push(
    '',
    'Send your *Binance Pay Order (Transaction) ID* now.',
    '',
    '_You can find it in: Binance App → Pay → Transaction History → tap the transaction → copy the Order ID_',
  );

  await bot.sendMessage(chatId, fallbackLines.join('\n'), { parse_mode: 'Markdown' });
}

module.exports = { register };
