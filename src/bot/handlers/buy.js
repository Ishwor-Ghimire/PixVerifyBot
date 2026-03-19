const config = require('../../config');
const PaymentService = require('../../services/paymentService');
const { MESSAGES, CALLBACKS } = require('../../utils/constants');
const logger = require('../../utils/logger');

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

    // Remove selection buttons
    try {
      await bot.editMessageReplyMarkup(
        { inline_keyboard: [] },
        { chat_id: chatId, message_id: query.message.message_id }
      );
    } catch {}

    if (methodId === 'usdt_bep20') {
      await handleUsdtPayment(bot, chatId, userId, pkg);
    } else if (methodId === 'binance_pay') {
      await handleBinancePayment(bot, chatId, userId, pkg);
    }
  });

  // Handle pay cancel
  bot.on('callback_query', async (query) => {
    if (query.data !== CALLBACKS.PAY_CANCEL) return;
    await bot.answerCallbackQuery(query.id, { text: 'Cancelled' });
    try {
      await bot.editMessageText('🚫 Purchase cancelled.', {
        chat_id: query.message.chat.id,
        message_id: query.message.message_id,
      });
    } catch {}
  });
}

/**
 * Handle USDT BEP-20 payment flow
 */
async function handleUsdtPayment(bot, chatId, userId, pkg) {
  const order = PaymentService.createUsdtOrder(userId, pkg);

  const msg = [
    '💎 *USDT (BEP-20) Payment*',
    '',
    `📋 Order #${order.orderId}`,
    `📦 Package: *${pkg.label}*`,
    '',
    `💰 Send exactly: *\`${order.uniqueAmount.toFixed(6)}\` USDT*`,
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
 * Handle Binance Pay payment flow
 */
async function handleBinancePayment(bot, chatId, userId, pkg) {
  const waitMsg = await bot.sendMessage(chatId, '🔄 Creating Binance Pay order...');

  try {
    const order = await PaymentService.createBinancePayOrder(userId, pkg);

    if (!order.orderId) {
      return bot.editMessageText(
        '⚠️ Failed to create payment order. Please try again or use USDT (BEP-20).',
        { chat_id: chatId, message_id: waitMsg.message_id }
      );
    }

    const msg = [
      '🟡 *Binance Pay*',
      '',
      `📋 Order #${order.orderId}`,
      `📦 Package: *${pkg.label}*`,
      `💰 Amount: *$${pkg.price} USDT*`,
      '',
      '👇 Click the button below to pay:',
    ].join('\n');

    await bot.editMessageText(msg, {
      chat_id: chatId,
      message_id: waitMsg.message_id,
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[
          { text: '💳 Pay with Binance', url: order.checkoutUrl },
        ]],
      },
    });
  } catch (err) {
    logger.error('Binance Pay order error', { error: err.message });
    await bot.editMessageText(
      '⚠️ Failed to create payment order. Please try again later.',
      { chat_id: chatId, message_id: waitMsg.message_id }
    );
  }
}

module.exports = { register };
