const User = require('../../db/models/User');
const Purchase = require('../../db/models/Purchase');
const CreditService = require('../../services/creditService');
const { MESSAGES, CALLBACKS } = require('../../utils/constants');
const { formatDate } = require('../../utils/helpers');
const logger = require('../../utils/logger');

// Pending admin confirmations (scam prevention: admin must see details before confirming)
const pendingConfirmations = new Map();

function register(bot) {
  // /orders — List pending purchase orders (admin only)
  bot.onText(/\/orders/, async (msg) => {
    if (!User.isAdmin(msg.from.id)) {
      return bot.sendMessage(msg.chat.id, MESSAGES.ADMIN_ONLY);
    }

    const pending = Purchase.getPending();

    if (pending.length === 0) {
      return bot.sendMessage(msg.chat.id, '📋 No pending orders.');
    }

    let text = '📋 *Pending Orders*\n\n';
    for (const p of pending) {
      const user = User.findById(p.telegram_user_id);
      const username = user?.username ? `@${user.username}` : `ID:${p.telegram_user_id}`;
      text += `*#${p.id}* — ${username}\n`;
      text += `  💰 $${p.amount} → ${p.credits_added} credits\n`;
      text += `  📱 ${p.payment_method || p.payment_provider}\n`;
      if (p.unique_amount) text += `  🔢 Unique: $${p.unique_amount}\n`;
      text += `  🕐 ${formatDate(p.created_at)}\n\n`;
    }

    text += `Total: ${pending.length} pending\n\nTo confirm: /confirm <order\\_id>`;

    await bot.sendMessage(msg.chat.id, text, { parse_mode: 'Markdown' });
  });

  // /confirm <order_id> — Admin manual payment confirmation (scam-proof 2-step)
  bot.onText(/\/confirm(?:\s+(\d+))?/, async (msg, match) => {
    if (!User.isAdmin(msg.from.id)) {
      return bot.sendMessage(msg.chat.id, MESSAGES.ADMIN_ONLY);
    }

    const orderId = match[1] ? parseInt(match[1], 10) : null;
    if (!orderId) {
      return bot.sendMessage(msg.chat.id, '⚠️ Usage: /confirm <order\\_id>\n\nUse /orders to see pending orders.', {
        parse_mode: 'Markdown',
      });
    }

    const purchase = Purchase.getById(orderId);
    if (!purchase) {
      return bot.sendMessage(msg.chat.id, `⚠️ Order #${orderId} not found.`);
    }

    if (purchase.payment_status === 'completed') {
      return bot.sendMessage(msg.chat.id, `✅ Order #${orderId} is already confirmed.`);
    }

    if (purchase.payment_status !== 'pending') {
      return bot.sendMessage(msg.chat.id, `⚠️ Order #${orderId} status is "${purchase.payment_status}" — cannot confirm.`);
    }

    // Scam prevention: show full details and require explicit confirmation
    const user = User.findById(purchase.telegram_user_id);
    const username = user?.username ? `@${user.username}` : `ID:${purchase.telegram_user_id}`;
    const currentBalance = CreditService.getBalance(purchase.telegram_user_id);

    const confirmKey = `admin_confirm_${orderId}_${msg.from.id}`;

    const detailText = [
      `🔍 *Order #${orderId} — Review Before Confirming*`,
      '',
      `👤 *User:* ${username} (ID: ${purchase.telegram_user_id})`,
      `💰 *Current balance:* ${currentBalance} credits`,
      '',
      `📦 *Order Details:*`,
      `  Amount: *$${purchase.amount}*`,
      `  Credits: *${purchase.credits_added}*`,
      `  Method: ${purchase.payment_method || purchase.payment_provider}`,
      purchase.unique_amount ? `  Unique amount: $${purchase.unique_amount}` : '',
      purchase.payment_reference ? `  Reference: \`${purchase.payment_reference}\`` : '',
      `  Created: ${formatDate(purchase.created_at)}`,
      '',
      '⚠️ *Confirm this payment? This will add credits to the user immediately.*',
    ].filter(Boolean).join('\n');

    // Store confirmation token
    pendingConfirmations.set(confirmKey, {
      orderId,
      telegramUserId: purchase.telegram_user_id,
      credits: purchase.credits_added,
      adminId: msg.from.id,
      createdAt: Date.now(),
    });

    // Auto-expire confirmation after 2 minutes
    setTimeout(() => pendingConfirmations.delete(confirmKey), 2 * 60 * 1000);

    await bot.sendMessage(msg.chat.id, detailText, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[
          { text: '✅ Yes, confirm payment', callback_data: `${CALLBACKS.ADMIN_CONFIRM}${orderId}` },
          { text: '❌ Cancel', callback_data: `${CALLBACKS.ADMIN_REJECT}${orderId}` },
        ]],
      },
    });
  });

  // Handle admin confirm/reject callbacks
  bot.on('callback_query', async (query) => {
    const { data } = query;
    if (!data) return;

    if (data.startsWith(CALLBACKS.ADMIN_CONFIRM)) {
      await handleAdminConfirm(bot, query);
    } else if (data.startsWith(CALLBACKS.ADMIN_REJECT)) {
      await handleAdminReject(bot, query);
    }
  });

  // /reject <order_id> — Reject/expire a pending order
  bot.onText(/\/reject(?:\s+(\d+))?/, async (msg, match) => {
    if (!User.isAdmin(msg.from.id)) {
      return bot.sendMessage(msg.chat.id, MESSAGES.ADMIN_ONLY);
    }

    const orderId = match[1] ? parseInt(match[1], 10) : null;
    if (!orderId) {
      return bot.sendMessage(msg.chat.id, '⚠️ Usage: /reject <order\\_id>', { parse_mode: 'Markdown' });
    }

    const purchase = Purchase.getById(orderId);
    if (!purchase || purchase.payment_status !== 'pending') {
      return bot.sendMessage(msg.chat.id, `⚠️ Order #${orderId} not found or not pending.`);
    }

    Purchase.updateStatus(orderId, { paymentStatus: 'rejected' });
    logger.info('Order rejected by admin', { orderId, adminId: msg.from.id });

    await bot.sendMessage(msg.chat.id, `🚫 Order #${orderId} has been rejected.`);

    // Notify user
    try {
      await bot.sendMessage(purchase.telegram_user_id,
        `❌ Your order #${orderId} has been rejected. Please contact support if you believe this is an error.`
      );
    } catch {}
  });

  // /addcredits <user_id> <amount> — Admin direct credit add
  bot.onText(/\/addcredits(?:\s+(\d+)\s+(\d+(?:\.\d+)?))?/, async (msg, match) => {
    if (!User.isAdmin(msg.from.id)) {
      return bot.sendMessage(msg.chat.id, MESSAGES.ADMIN_ONLY);
    }

    const userId = match[1] ? parseInt(match[1], 10) : null;
    const amount = match[2] ? parseFloat(match[2]) : null;

    if (!userId || !amount || amount <= 0) {
      return bot.sendMessage(msg.chat.id, '⚠️ Usage: /addcredits <telegram\\_user\\_id> <amount>', {
        parse_mode: 'Markdown',
      });
    }

    const user = User.findById(userId);
    if (!user) {
      return bot.sendMessage(msg.chat.id, `⚠️ User ${userId} not found.`);
    }

    CreditService.addCredits(userId, amount);
    const newBalance = CreditService.getBalance(userId);

    logger.info('Admin added credits', { adminId: msg.from.id, userId, amount, newBalance });

    const username = user.username ? `@${user.username}` : `ID:${userId}`;
    await bot.sendMessage(msg.chat.id,
      `✅ Added *${amount}* credits to ${username}.\nNew balance: *${newBalance}*`,
      { parse_mode: 'Markdown' }
    );

    // Notify user
    try {
      await bot.sendMessage(userId,
        `💰 *${amount} credits* have been added to your account by an admin.\nNew balance: *${newBalance}*`,
        { parse_mode: 'Markdown' }
      );
    } catch {}
  });
}

async function handleAdminConfirm(bot, query) {
  const adminId = query.from.id;
  if (!User.isAdmin(adminId)) {
    return bot.answerCallbackQuery(query.id, { text: 'Admin only' });
  }

  const orderId = parseInt(query.data.replace(CALLBACKS.ADMIN_CONFIRM, ''), 10);
  const confirmKey = `admin_confirm_${orderId}_${adminId}`;
  const token = pendingConfirmations.get(confirmKey);

  if (!token) {
    await bot.answerCallbackQuery(query.id, { text: 'Confirmation expired. Use /confirm again.' });
    return;
  }

  // Double-check order is still pending
  const purchase = Purchase.getById(orderId);
  if (!purchase || purchase.payment_status !== 'pending') {
    pendingConfirmations.delete(confirmKey);
    await bot.answerCallbackQuery(query.id, { text: 'Order no longer pending.' });
    return;
  }

  // Confirm payment
  Purchase.updateStatus(orderId, {
    paymentStatus: 'completed',
    paymentReference: `manual_admin_${adminId}_${Date.now()}`,
  });

  CreditService.addCredits(purchase.telegram_user_id, purchase.credits_added);
  pendingConfirmations.delete(confirmKey);

  logger.info('Admin confirmed payment', { orderId, adminId, credits: purchase.credits_added });

  await bot.answerCallbackQuery(query.id, { text: '✅ Payment confirmed!' });

  // Update the message
  try {
    await bot.editMessageText(
      `✅ *Order #${orderId} confirmed by admin*\n\n${purchase.credits_added} credits added to user ${purchase.telegram_user_id}.`,
      {
        chat_id: query.message.chat.id,
        message_id: query.message.message_id,
        parse_mode: 'Markdown',
      }
    );
  } catch {}

  // Notify the user
  try {
    await bot.sendMessage(purchase.telegram_user_id, [
      '✅ *Payment Confirmed!*',
      '',
      `💰 *${purchase.credits_added} credits* added to your balance.`,
      `📋 Order #${orderId}`,
      '',
      'Use /run to generate a link or /balance to check your balance.',
    ].join('\n'), { parse_mode: 'Markdown' });
  } catch {}
}

async function handleAdminReject(bot, query) {
  const adminId = query.from.id;
  if (!User.isAdmin(adminId)) {
    return bot.answerCallbackQuery(query.id, { text: 'Admin only' });
  }

  const orderId = parseInt(query.data.replace(CALLBACKS.ADMIN_REJECT, ''), 10);
  const confirmKey = `admin_confirm_${orderId}_${adminId}`;
  pendingConfirmations.delete(confirmKey);

  await bot.answerCallbackQuery(query.id, { text: 'Cancelled' });

  try {
    await bot.editMessageText(
      `🚫 Confirmation cancelled for order #${orderId}.`,
      {
        chat_id: query.message.chat.id,
        message_id: query.message.message_id,
      }
    );
  } catch {}
}

module.exports = { register };
