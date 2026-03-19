const config = require('../../config');
const PaymentService = require('../../services/paymentService');
const { MESSAGES, CALLBACKS } = require('../../utils/constants');
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
    } catch {}

    if (methodId === 'usdt_bep20') {
      await handleUsdtPayment(bot, chatId, userId, pkg);
    } else if (methodId === 'usdt_trc20') {
      await handleUsdtTrc20Payment(bot, chatId, userId, pkg);
    } else if (methodId === 'binance_transfer') {
      await handleBinanceTransfer(bot, chatId, userId, pkg);
    }
  });

  // Handle "I've paid" button for Binance Transfer
  bot.on('callback_query', async (query) => {
    if (!query.data?.startsWith(CALLBACKS.BINANCE_PAID)) return;

    const orderId = parseInt(query.data.replace(CALLBACKS.BINANCE_PAID, ''), 10);
    const userId = query.from.id;

    await bot.answerCallbackQuery(query.id);

    // Store that this user needs to submit a transaction ID
    pendingVerifications.set(userId, { orderId, chatId: query.message.chat.id });

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

    // Save the transaction ID as payment reference on the order
    try {
      const Purchase = require('../../db/models/Purchase');
      const purchase = Purchase.getById(pending.orderId);
      if (purchase && purchase.payment_status === 'pending') {
        Purchase.updateStatusIfPending(pending.orderId, {
          paymentStatus: 'pending', // keep pending for admin
          paymentReference: `binance_txid_${submittedId}`,
        });
      }
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
    const username = msg.from.username ? `@${msg.from.username}` : `ID:${userId}`;

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
    } catch {}
  });
}

/**
 * Handle USDT BEP-20 payment flow (auto-detected via blockchain)
 */
async function handleUsdtPayment(bot, chatId, userId, pkg) {
  const order = PaymentService.createUsdtOrder(userId, pkg);

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
    '• Your credits will be added *automatically* once the transaction is confirmed',
    '',
    '⏱️ This order expires in 60 minutes.',
  ].join('\n');

  await bot.sendMessage(chatId, msg, { parse_mode: 'Markdown' });
}

/**
 * Handle USDT TRC-20 payment flow (auto-detected via blockchain)
 */
async function handleUsdtTrc20Payment(bot, chatId, userId, pkg) {
  const order = PaymentService.createUsdtTrc20Order(userId, pkg);

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
    '• Your credits will be added *automatically* once the transaction is confirmed',
    '',
    '⏱️ This order expires in 60 minutes.',
  ].join('\n');

  await bot.sendMessage(chatId, msg, { parse_mode: 'Markdown' });
}

/**
 * Handle Binance Transfer payment flow
 */
async function handleBinanceTransfer(bot, chatId, userId, pkg) {
  const order = PaymentService.createBinanceTransferOrder(userId, pkg);

  const msg = [
    '🟡 *Binance Pay Payment*',
    '',
    `📋 Order #${order.orderId}`,
    `📦 Package: *${pkg.label}*`,
    `💰 Amount: *$${pkg.price} USDT*`,
    '',
    '📬 *Send USDT via Binance Pay to:*',
    `Pay ID: \`${order.binancePayId}\``,
    '',
    '📝 *Steps:*',
    '1. Open *Binance App* → *Pay* → *Send*',
    '2. Enter the Pay ID above',
    `3. Send exactly *$${pkg.price} USDT*`,
    '4. After sending, tap *"I\'ve Paid"* below and send your Transaction ID',
    '',
    '⏱️ This order expires in 60 minutes.',
  ].join('\n');

  await bot.sendMessage(chatId, msg, {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [{ text: '✅ I\'ve Paid', callback_data: `${CALLBACKS.BINANCE_PAID}${order.orderId}` }],
        [{ text: '❌ Cancel', callback_data: CALLBACKS.PAY_CANCEL }],
      ],
    },
  });
}

module.exports = { register };
