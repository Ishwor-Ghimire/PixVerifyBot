const User = require('../../db/models/User');
const Purchase = require('../../db/models/Purchase');
const CreditService = require('../../services/creditService');
const PaymentService = require('../../services/paymentService');
const { MESSAGES, CALLBACKS } = require('../../utils/constants');
const { formatDate } = require('../../utils/helpers');
const logger = require('../../utils/logger');

// Pending admin confirmations
const pendingConfirmations = new Map();

function register(bot) {
  // ==========================================
  // MAIN DASHBOARD ENTRY
  // ==========================================
  bot.onText(/\/admin/, async (msg) => {
    if (!User.isAdmin(msg.from.id)) {
      return bot.sendMessage(msg.chat.id, MESSAGES.ADMIN_ONLY);
    }
    await sendAdminDashboard(bot, msg.chat.id);
  });

  // ==========================================
  // INLINE BUTTON CALLBACKS
  // ==========================================
  bot.on('callback_query', async (query) => {
    const { data, from, message } = query;
    if (!data) return;

    if (data.startsWith('adm_')) {
      if (!User.isAdmin(from.id)) {
        return bot.answerCallbackQuery(query.id, { text: 'Admin only' });
      }

      // Route the admin actions
      if (data === CALLBACKS.ADMIN_MENU) {
        await bot.answerCallbackQuery(query.id);
        await sendAdminDashboard(bot, message.chat.id, message.message_id);
      } else if (data === CALLBACKS.ADMIN_STATS) {
        await bot.answerCallbackQuery(query.id);
        await showStats(bot, message.chat.id, message.message_id);
      } else if (data === 'adm_orders_list') {
        await bot.answerCallbackQuery(query.id);
        await showPendingOrders(bot, message.chat.id, message.message_id);
      } else if (data.startsWith(CALLBACKS.ADMIN_CONFIRM)) {
        await handleAdminConfirm(bot, query);
      } else if (data.startsWith(CALLBACKS.ADMIN_REJECT)) {
        await handleAdminReject(bot, query);
      }
    }
  });

  // ==========================================
  // LEGACY COMMANDS (Kept for convenience/speed)
  // ==========================================
  bot.onText(/\/orders/, async (msg) => {
    if (!User.isAdmin(msg.from.id)) return bot.sendMessage(msg.chat.id, MESSAGES.ADMIN_ONLY);
    await showPendingOrders(bot, msg.chat.id);
  });

  bot.onText(/\/confirm(?:\s+(\d+))?/, async (msg, match) => {
    if (!User.isAdmin(msg.from.id)) return bot.sendMessage(msg.chat.id, MESSAGES.ADMIN_ONLY);
    await startConfirmFlow(bot, msg.chat.id, msg.from.id, match[1]);
  });

  bot.onText(/\/reject(?:\s+(\d+))?/, async (msg, match) => {
    if (!User.isAdmin(msg.from.id)) return bot.sendMessage(msg.chat.id, MESSAGES.ADMIN_ONLY);
    await rejectOrder(bot, msg.chat.id, msg.from.id, match[1]);
  });

  bot.onText(/\/addcredits(?:\s+(\d+)\s+(\d+(?:\.\d+)?))?/, async (msg, match) => {
    if (!User.isAdmin(msg.from.id)) return bot.sendMessage(msg.chat.id, MESSAGES.ADMIN_ONLY);
    await addCreditsManual(bot, msg.chat.id, msg.from.id, match[1], match[2]);
  });
}

// ==========================================
// DASHBOARD VIEWS
// ==========================================

async function sendAdminDashboard(bot, chatId, messageId = null) {
  const pendingCount = Purchase.getPending().length;
  
  const text = [
    '👑 *Admin Control Panel*',
    '',
    'Welcome to the PixVerifyBot admin dashboard. Select an action below:',
    '',
    `🟢 *Orders Pending:* ${pendingCount}`,
  ].join('\n');

  const buttons = [
    [{ text: '📊 Global Statistics', callback_data: CALLBACKS.ADMIN_STATS }],
    [{ text: `📋 Pending Orders (${pendingCount})`, callback_data: 'adm_orders_list' }],
    [{ text: '💳 Add Credits to User', url: `https://t.me/${bot.options.username}?start=admin_addcredits` }], 
    [{ text: '❌ Close Panel', callback_data: 'adm_close' }]
  ]; // Note: adding credits requires typing, so we hint the command or use deep linking (placeholder)

  // Realistically, addCredits is best done via command due to input needs, 
  // but we provide the command instructions in the panel text or a dedicated button.
  const keyboard = { inline_keyboard: [
    [{ text: '📊 Global Statistics', callback_data: CALLBACKS.ADMIN_STATS }],
    [{ text: `📦 Pending Orders (${pendingCount})`, callback_data: 'adm_orders_list' }],
    [{ text: '❓ Help / Commands', callback_data: 'adm_help' }]
  ]};

  bot.on('callback_query', async (query) => {
      if(query.data === 'adm_help') {
          await bot.answerCallbackQuery(query.id);
          const helpText = [
            '🛠 *Admin Commands*',
            '',
            '`/admin` — Open this dashboard',
            '`/orders` — List pending orders',
            '`/confirm <id>` — Confirm an order',
            '`/reject <id>` — Reject an order',
            '`/addcredits <userId> <amount>` — Give credits direct',
            '`/health` — Check external API health'
          ].join('\n');
          await bot.editMessageText(helpText, {
            chat_id: query.message.chat.id,
            message_id: query.message.message_id,
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: [[{ text: '⬅️ Back to Panel', callback_data: CALLBACKS.ADMIN_MENU }]] }
          });
      }
  });

  if (messageId) {
    try {
      await bot.editMessageText(text, { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown', reply_markup: keyboard });
    } catch {}
  } else {
    await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: keyboard });
  }
}

async function showStats(bot, chatId, messageId) {
  const userStats = User.getStats();
  const purchaseStats = Purchase.getStats();

  const text = [
    '📊 *Global Statistics*',
    '',
    '👥 *Users*',
    `• Total Users: *${userStats.totalUsers}*`,
    `• Outstanding Credits: *${userStats.outstandingCredits}*`,
    '',
    '💰 *Revenue & Sales*',
    `• Total Revenue: *$${purchaseStats.totalRevenue.toFixed(2)} USD*`,
    `• Credits Sold: *${purchaseStats.totalCreditsSold}*`,
    `• Completed Orders: *${purchaseStats.totalOrders}*`,
  ].join('\n');

  const keyboard = { inline_keyboard: [
    [{ text: '🔄 Refresh', callback_data: CALLBACKS.ADMIN_STATS }],
    [{ text: '⬅️ Back to Panel', callback_data: CALLBACKS.ADMIN_MENU }]
  ]};

  await bot.editMessageText(text, { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown', reply_markup: keyboard });
}

async function showPendingOrders(bot, chatId, messageId = null) {
  const pending = Purchase.getPending();

  if (pending.length === 0) {
    const text = '📋 *Pending Orders*\n\nNo pending orders at the moment.';
    const keyboard = { inline_keyboard: [[{ text: '⬅️ Back to Panel', callback_data: CALLBACKS.ADMIN_MENU }]] };
    
    if (messageId) {
      await bot.editMessageText(text, { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown', reply_markup: keyboard });
    } else {
      await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: keyboard });
    }
    return;
  }

  let text = '📋 *Pending Orders*\n\n';
  for (const p of pending) {
    text += `*#${p.id}* — User ID: \`${p.telegram_user_id}\`\n`;
    text += `  💰 $${p.amount} → ${p.credits_added} credits\n`;
    text += `  📱 ${p.payment_method || p.payment_provider}\n`;
    if (p.unique_amount) text += `  🔢 Unique: $${p.unique_amount}\n`;
    text += `  🕐 ${formatDate(p.created_at)}\n\n`;
  }

  text += `To confirm: \`/confirm <order_id>\`\nTo manually reject: \`/reject <order_id>\``;

  const keyboard = { inline_keyboard: [
    [{ text: '🔄 Refresh', callback_data: 'adm_orders_list' }],
    [{ text: '⬅️ Back to Panel', callback_data: CALLBACKS.ADMIN_MENU }]
  ]};

  if (messageId) {
    await bot.editMessageText(text, { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown', reply_markup: keyboard });
  } else {
    await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: keyboard });
  }
}

// ==========================================
// ACTION HANDLERS
// ==========================================

async function startConfirmFlow(bot, chatId, adminId, inputOrderId) {
  const orderId = inputOrderId ? parseInt(inputOrderId, 10) : null;
  if (!orderId) {
    return bot.sendMessage(chatId, '⚠️ Usage: `/confirm <order_id>`', { parse_mode: 'Markdown' });
  }

  const purchase = Purchase.getById(orderId);
  if (!purchase) return bot.sendMessage(chatId, `⚠️ Order #${orderId} not found.`);
  if (purchase.payment_status === 'completed') return bot.sendMessage(chatId, `✅ Order #${orderId} is already confirmed.`);
  if (purchase.payment_status !== 'pending') return bot.sendMessage(chatId, `⚠️ Order #${orderId} status is "${purchase.payment_status}" — cannot confirm.`);

  const user = User.findById(purchase.telegram_user_id);
  const username = user?.username ? `@${user.username}` : `ID:${purchase.telegram_user_id}`;
  const currentBalance = CreditService.getBalance(purchase.telegram_user_id);

  const confirmKey = `admin_confirm_${orderId}_${adminId}`;

  const detailText = [
    `🔍 *Order #${orderId} — Review Before Confirming*`,
    '',
    `👤 *User:* ${username} (ID: \`${purchase.telegram_user_id}\`)`,
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

  pendingConfirmations.set(confirmKey, {
    orderId,
    telegramUserId: purchase.telegram_user_id,
    credits: purchase.credits_added,
    adminId,
    createdAt: Date.now(),
  });

  setTimeout(() => pendingConfirmations.delete(confirmKey), 2 * 60 * 1000);

  await bot.sendMessage(chatId, detailText, {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [[
        { text: '✅ Yes, confirm payment', callback_data: `${CALLBACKS.ADMIN_CONFIRM}${orderId}` },
        { text: '❌ Cancel', callback_data: `${CALLBACKS.ADMIN_REJECT}${orderId}` },
      ]],
    },
  });
}

async function handleAdminConfirm(bot, query) {
  const adminId = query.from.id;
  const orderId = parseInt(query.data.replace(CALLBACKS.ADMIN_CONFIRM, ''), 10);
  const confirmKey = `admin_confirm_${orderId}_${adminId}`;
  
  if (!pendingConfirmations.has(confirmKey)) {
    return bot.answerCallbackQuery(query.id, { text: 'Confirmation expired. Use /confirm again.' });
  }

  const purchase = Purchase.getById(orderId);
  if (!purchase || purchase.payment_status !== 'pending') {
    pendingConfirmations.delete(confirmKey);
    return bot.answerCallbackQuery(query.id, { text: 'Order no longer pending.' });
  }

  const confirmation = PaymentService.confirmPayment(orderId, `manual_admin_${adminId}_${Date.now()}`);
  if (!confirmation.success) {
    pendingConfirmations.delete(confirmKey);
    return bot.answerCallbackQuery(query.id, { text: confirmation.error });
  }

  pendingConfirmations.delete(confirmKey);
  logger.info('Admin confirmed payment', { orderId, adminId, credits: purchase.credits_added });

  await bot.answerCallbackQuery(query.id, { text: '✅ Payment confirmed!' });

  try {
    await bot.editMessageText(
      `✅ *Order #${orderId} confirmed by admin*\n\n${purchase.credits_added} credits added to user \`${purchase.telegram_user_id}\`.`,
      { chat_id: query.message.chat.id, message_id: query.message.message_id, parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [[{ text: '⬅️ Back to Panel', callback_data: CALLBACKS.ADMIN_MENU }]] }
      }
    );
  } catch {}

  // Notify user
  try {
    await bot.sendMessage(purchase.telegram_user_id, [
      '✅ *Payment Confirmed!*', '',
      `💰 *${purchase.credits_added} credits* added to your balance.`,
      `📋 Order #${orderId}`, '',
      'Use /run to generate a link or /balance to check your balance.',
    ].join('\n'), { parse_mode: 'Markdown' });
  } catch {}
}

async function handleAdminReject(bot, query) {
  const adminId = query.from.id;
  const orderId = parseInt(query.data.replace(CALLBACKS.ADMIN_REJECT, ''), 10);
  const confirmKey = `admin_confirm_${orderId}_${adminId}`;
  
  pendingConfirmations.delete(confirmKey);
  await bot.answerCallbackQuery(query.id, { text: 'Cancelled' });

  try {
    await bot.editMessageText(
      `🚫 Confirmation cancelled for order #${orderId}.`,
      { chat_id: query.message.chat.id, message_id: query.message.message_id,
        reply_markup: { inline_keyboard: [[{ text: '⬅️ Back to Panel', callback_data: CALLBACKS.ADMIN_MENU }]] }
      }
    );
  } catch {}
}

async function rejectOrder(bot, chatId, adminId, inputOrderId) {
  const orderId = inputOrderId ? parseInt(inputOrderId, 10) : null;
  if (!orderId) return bot.sendMessage(chatId, '⚠️ Usage: `/reject <order_id>`', { parse_mode: 'Markdown' });

  const purchase = Purchase.getById(orderId);
  if (!purchase || purchase.payment_status !== 'pending') {
    return bot.sendMessage(chatId, `⚠️ Order #${orderId} not found or not pending.`);
  }

  Purchase.updateStatusIfPending(orderId, { paymentStatus: 'rejected' });
  logger.info('Order rejected by admin', { orderId, adminId });

  await bot.sendMessage(chatId, `🚫 Order #${orderId} has been rejected.`);

  try {
    await bot.sendMessage(purchase.telegram_user_id, `❌ Your order #${orderId} has been rejected. Please contact support if you believe this is an error.`);
  } catch {}
}

async function addCreditsManual(bot, chatId, adminId, inputUserId, inputAmount) {
  const userId = inputUserId ? parseInt(inputUserId, 10) : null;
  const amount = inputAmount ? parseFloat(inputAmount) : null;

  if (!userId || !amount || amount <= 0) {
    return bot.sendMessage(chatId, '⚠️ Usage: `/addcredits <telegram_user_id> <amount>`', { parse_mode: 'Markdown' });
  }

  const user = User.findById(userId);
  if (!user) return bot.sendMessage(chatId, `⚠️ User \`${userId}\` not found.`, { parse_mode: 'Markdown' });

  CreditService.addCredits(userId, amount);
  const newBalance = CreditService.getBalance(userId);

  logger.info('Admin added credits', { adminId, userId, amount, newBalance });

  const username = user.username ? `@${user.username}` : `ID:${userId}`;
  await bot.sendMessage(chatId, `✅ Added *${amount}* credits to ${username}.\nNew balance: *${newBalance}*`, { parse_mode: 'Markdown' });

  try {
    await bot.sendMessage(userId, `💰 *${amount} credits* have been added to your account by an admin.\nNew balance: *${newBalance}*`, { parse_mode: 'Markdown' });
  } catch {}
}

module.exports = { register };
