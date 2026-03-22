const User = require('../../db/models/User');
const Purchase = require('../../db/models/Purchase');
const CreditService = require('../../services/creditService');
const PaymentService = require('../../services/paymentService');
const GoogleOneClient = require('../../api/googleOneClient');
const MaintenanceService = require('../../services/maintenanceService');
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

  // /addbalance <id> <amount> — alias for addcredits (matching Api_Pixel_Bot)
  bot.onText(/\/addbalance(?:\s+(\d+)\s+(\d+(?:\.\d+)?))?/, async (msg, match) => {
    if (!User.isAdmin(msg.from.id)) return bot.sendMessage(msg.chat.id, MESSAGES.ADMIN_ONLY);
    await addCreditsManual(bot, msg.chat.id, msg.from.id, match[1], match[2]);
  });

  // /apistatus — API server health + queue overview
  bot.onText(/\/apistatus/, async (msg) => {
    if (!User.isAdmin(msg.from.id)) return bot.sendMessage(msg.chat.id, MESSAGES.ADMIN_ONLY);
    await showApiStatus(bot, msg.chat.id);
  });

  // /apibalance — remaining API key credits
  bot.onText(/\/apibalance/, async (msg) => {
    if (!User.isAdmin(msg.from.id)) return bot.sendMessage(msg.chat.id, MESSAGES.ADMIN_ONLY);
    await showApiBalance(bot, msg.chat.id);
  });

  // /maintenance — toggle maintenance mode
  bot.onText(/\/maintenance/, async (msg) => {
    if (!User.isAdmin(msg.from.id)) return bot.sendMessage(msg.chat.id, MESSAGES.ADMIN_ONLY);
    const isNowEnabled = MaintenanceService.toggle();
    const label = isNowEnabled ? '🔴 ON — New verifications are blocked' : '🟢 OFF — System is operational';
    logger.info('Maintenance mode toggled', { enabled: isNowEnabled, by: msg.from.id });
    await bot.sendMessage(msg.chat.id, `🔧 *Maintenance Mode:* ${label}`, { parse_mode: 'Markdown' });
  });

  // /removecredits <id> <amount> — remove credits from a user
  bot.onText(/\/removecredits(?:\s+(\d+)\s+(\d+(?:\.\d+)?))?/, async (msg, match) => {
    if (!User.isAdmin(msg.from.id)) return bot.sendMessage(msg.chat.id, MESSAGES.ADMIN_ONLY);
    await removeCreditsManual(bot, msg.chat.id, msg.from.id, match[1], match[2]);
  });

  // /checkcredits <id> — check a user's credit balance
  bot.onText(/\/checkcredits(?:\s+(\d+))?/, async (msg, match) => {
    if (!User.isAdmin(msg.from.id)) return bot.sendMessage(msg.chat.id, MESSAGES.ADMIN_ONLY);
    await checkCredits(bot, msg.chat.id, match[1]);
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
            '`/addcredits <userId> <amount>` — Give credits',
            '`/removecredits <userId> <amount>` — Remove credits',
            '`/checkcredits <userId>` — Check user balance',
            '`/addbalance <userId> <amount>` — Alias for addcredits',
            '`/apistatus` — API server health & devices',
            '`/apibalance` — Check API key balance',
            '`/maintenance` — Toggle maintenance mode',
            '`/health` — Quick API health check'
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
    const user = User.findById(p.telegram_user_id);
    const username = user?.username ? `@${user.username}` : 'N/A';
    text += `*#${p.id}* — ${username} (\`${p.telegram_user_id}\`)\n`;
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

  const purchase = Purchase.getById(orderId);
  if (!purchase) {
    return bot.answerCallbackQuery(query.id, { text: 'Order not found.' });
  }
  if (purchase.payment_status !== 'pending') {
    return bot.answerCallbackQuery(query.id, { text: `Order already ${purchase.payment_status}.` });
  }

  const confirmation = PaymentService.confirmPayment(orderId, `manual_admin_${adminId}_${Date.now()}`);
  if (!confirmation.success) {
    return bot.answerCallbackQuery(query.id, { text: confirmation.error });
  }

  // Clean up any pending confirmation entry
  const confirmKey = `admin_confirm_${orderId}_${adminId}`;
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
      'Use /run to start verification or /balance to check your balance.',
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
// ==========================================
// CREDIT MANAGEMENT
// ==========================================

async function removeCreditsManual(bot, chatId, adminId, inputUserId, inputAmount) {
  const userId = inputUserId ? parseInt(inputUserId, 10) : null;
  const amount = inputAmount ? parseFloat(inputAmount) : null;

  if (!userId || !amount || amount <= 0) {
    return bot.sendMessage(chatId, '⚠️ Usage: `/removecredits <telegram_user_id> <amount>`', { parse_mode: 'Markdown' });
  }

  const user = User.findById(userId);
  if (!user) return bot.sendMessage(chatId, `⚠️ User \`${userId}\` not found.`, { parse_mode: 'Markdown' });

  const success = CreditService.removeCredits(userId, amount);
  if (!success) {
    const currentBalance = CreditService.getBalance(userId);
    return bot.sendMessage(chatId, `⚠️ Cannot remove *${amount}* credits. User only has *${currentBalance}* credits.`, { parse_mode: 'Markdown' });
  }

  const newBalance = CreditService.getBalance(userId);
  logger.info('Admin removed credits', { adminId, userId, amount, newBalance });

  const username = user.username ? `@${user.username}` : `ID:${userId}`;
  await bot.sendMessage(chatId, `✅ Removed *${amount}* credits from ${username}.\nNew balance: *${newBalance}*`, { parse_mode: 'Markdown' });

  try {
    await bot.sendMessage(userId, `💸 *${amount} credits* have been removed from your account by an admin.\nNew balance: *${newBalance}*`, { parse_mode: 'Markdown' });
  } catch {}
}

async function checkCredits(bot, chatId, inputUserId) {
  const userId = inputUserId ? parseInt(inputUserId, 10) : null;

  if (!userId) {
    return bot.sendMessage(chatId, '⚠️ Usage: `/checkcredits <telegram_user_id>`', { parse_mode: 'Markdown' });
  }

  const user = User.findById(userId);
  if (!user) return bot.sendMessage(chatId, `⚠️ User \`${userId}\` not found.`, { parse_mode: 'Markdown' });

  const balance = CreditService.getBalance(userId);
  const username = user.username ? `@${user.username}` : 'N/A';
  const firstName = user.first_name || 'N/A';

  const msg = [
    '👤 *User Credit Info*',
    '',
    `📛 Name: ${firstName}`,
    `🔗 Username: ${username}`,
    `🆔 ID: \`${userId}\``,
    `💰 Credits: *${balance}*`,
  ].join('\n');

  await bot.sendMessage(chatId, msg, { parse_mode: 'Markdown' });
}


// ==========================================

async function showApiStatus(bot, chatId) {
  try {
    const [health, queue] = await Promise.all([
      GoogleOneClient.checkHealth(),
      GoogleOneClient.getQueue(),
    ]);

    if (!health.ok) {
      return bot.sendMessage(chatId, `❌ API health check failed: ${health.error}`);
    }

    const deviceStatus = health.devices_connected === health.device_count ? '🟢' : '🟡';
    const maintenanceLabel = MaintenanceService.isEnabled() ? '🔴 Maintenance ON' : '🟢 Operational';

    const msg = [
      '🖥️ *API Server Status*',
      '',
      `${deviceStatus} *Server:* ${(health.status || 'unknown').toUpperCase()}`,
      `📱 *Devices:* ${health.devices_connected ?? '?'}/${health.device_count ?? '?'} ready`,
      '',
      '📋 *Queue:*',
      `🔄 Running: ${queue.ok ? (queue.current_job_ids?.filter(j => j !== null).length ?? 0) : '?'}`,
      `⏳ Pending: ${queue.ok ? (queue.pending_count ?? 0) : '?'}`,
      `⚡ Ready: ${queue.ok ? `${queue.devices_ready ?? '?'}/${queue.device_count ?? '?'}` : '?'}`,
      `⏱️ Est. per job: ~${queue.ok ? (queue.est_seconds_per_job ?? '?') : '?'}s`,
      '',
      `🔧 *Bot Mode:* ${maintenanceLabel}`,
    ].join('\n');

    await bot.sendMessage(chatId, msg, { parse_mode: 'Markdown' });
  } catch (e) {
    logger.error('apistatus command failed', { error: e.message });
    await bot.sendMessage(chatId, `❌ API connection error: ${e.message}`);
  }
}

async function showApiBalance(bot, chatId) {
  try {
    const balance = await GoogleOneClient.getApiBalance();
    if (!balance) {
      return bot.sendMessage(chatId, '❌ Failed to fetch API balance.');
    }

    const msg = [
      '💳 *API Key Balance*',
      '',
      `🔑 Key: \`${balance.key || 'N/A'}\``,
      `📛 Name: ${balance.name || 'N/A'}`,
      `💰 Remaining: *${balance.balance ?? 'N/A'}*`,
      `📊 Total used: ${balance.total_used ?? 'N/A'}`,
      `💵 Cost per job: ${balance.cost_per_job ?? 'N/A'}`,
    ].join('\n');

    await bot.sendMessage(chatId, msg, { parse_mode: 'Markdown' });
  } catch (e) {
    logger.error('apibalance command failed', { error: e.message });
    await bot.sendMessage(chatId, `❌ Error: ${e.message}`);
  }
}

module.exports = { register };
