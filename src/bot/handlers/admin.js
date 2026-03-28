const User = require('../../db/models/User');
const Purchase = require('../../db/models/Purchase');
const CreditService = require('../../services/creditService');
const PaymentService = require('../../services/paymentService');
const GoogleOneClient = require('../../api/googleOneClient');
const MaintenanceService = require('../../services/maintenanceService');
const ShadowBanService = require('../../services/shadowBanService');
const { MESSAGES, CALLBACKS } = require('../../utils/constants');
const { formatDate, escapeMarkdownV1 } = require('../../utils/helpers');
const config = require('../../config');
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
      } else if (data === 'adm_help') {
        await bot.answerCallbackQuery(query.id);
        await showAdminHelp(bot, message.chat.id, message.message_id);
      } else if (data.startsWith(CALLBACKS.ADMIN_CONFIRM)) {
        await handleAdminConfirm(bot, query);
      } else if (data.startsWith(CALLBACKS.ADMIN_REJECT)) {
        await handleAdminReject(bot, query);
      } else if (data.startsWith('adm_addcr_yes_')) {
        await executeAddCredits(bot, query);
      } else if (data.startsWith('adm_addcr_no_')) {
        await cancelCreditAction(bot, query, 'adm_addcr_no_');
      } else if (data.startsWith('adm_rmcr_yes_')) {
        await executeRemoveCredits(bot, query);
      } else if (data.startsWith('adm_rmcr_no_')) {
        await cancelCreditAction(bot, query, 'adm_rmcr_no_');
      }
    }
  });

  // ==========================================
  // LEGACY COMMANDS (Kept for convenience/speed)
  // ==========================================
  bot.onText(/\/orders(?:@\w+)?\s*$/, async (msg) => {
    if (!User.isAdmin(msg.from.id)) return bot.sendMessage(msg.chat.id, MESSAGES.ADMIN_ONLY);
    await showPendingOrders(bot, msg.chat.id);
  });

  bot.onText(/\/confirm(?:@\w+)?(?:\s+(\d+))?\s*$/, async (msg, match) => {
    if (!User.isAdmin(msg.from.id)) return bot.sendMessage(msg.chat.id, MESSAGES.ADMIN_ONLY);
    await startConfirmFlow(bot, msg.chat.id, msg.from.id, match[1]);
  });

  bot.onText(/\/reject(?:@\w+)?(?:\s+(\d+))?\s*$/, async (msg, match) => {
    if (!User.isAdmin(msg.from.id)) return bot.sendMessage(msg.chat.id, MESSAGES.ADMIN_ONLY);
    await rejectOrder(bot, msg.chat.id, msg.from.id, match[1]);
  });

  bot.onText(/\/addcredits(?:@\w+)?(?:\s+(\d+)\s+(\d+(?:\.\d+)?))?\s*$/, async (msg, match) => {
    if (!User.isAdmin(msg.from.id)) return bot.sendMessage(msg.chat.id, MESSAGES.ADMIN_ONLY);
    await addCreditsManual(bot, msg.chat.id, msg.from.id, match[1], match[2]);
  });

  // /addbalance <id> <amount> — alias for addcredits (matching Api_Pixel_Bot)
  bot.onText(/\/addbalance(?:@\w+)?(?:\s+(\d+)\s+(\d+(?:\.\d+)?))?\s*$/, async (msg, match) => {
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
  bot.onText(/\/removecredits(?:@\w+)?(?:\s+(\d+)\s+(\d+(?:\.\d+)?))?\s*$/, async (msg, match) => {
    if (!User.isAdmin(msg.from.id)) return bot.sendMessage(msg.chat.id, MESSAGES.ADMIN_ONLY);
    await removeCreditsManual(bot, msg.chat.id, msg.from.id, match[1], match[2]);
  });

  // /checkcredits <id> — check a user's credit balance
  bot.onText(/\/checkcredits(?:@\w+)?(?:\s+(\d+))?\s*$/, async (msg, match) => {
    if (!User.isAdmin(msg.from.id)) return bot.sendMessage(msg.chat.id, MESSAGES.ADMIN_ONLY);
    await checkCredits(bot, msg.chat.id, match[1]);
  });

  // /ban <id> — shadow ban a user
  bot.onText(/\/ban(?:@\w+)?(?:\s+(\d+))?\s*$/, async (msg, match) => {
    if (!User.isAdmin(msg.from.id)) return bot.sendMessage(msg.chat.id, MESSAGES.ADMIN_ONLY);
    await shadowBan(bot, msg.chat.id, match[1]);
  });

  // /unban <id> — remove shadow ban from a user
  bot.onText(/\/unban(?:@\w+)?(?:\s+(\d+))?\s*$/, async (msg, match) => {
    if (!User.isAdmin(msg.from.id)) return bot.sendMessage(msg.chat.id, MESSAGES.ADMIN_ONLY);
    await shadowUnban(bot, msg.chat.id, match[1]);
  });

  // /banlist — list all shadow banned users
  bot.onText(/\/banlist/, async (msg) => {
    if (!User.isAdmin(msg.from.id)) return bot.sendMessage(msg.chat.id, MESSAGES.ADMIN_ONLY);
    await showBanList(bot, msg.chat.id);
  });
}

// ==========================================
// DASHBOARD VIEWS
// ==========================================

async function sendAdminDashboard(bot, chatId, messageId = null) {
  const pendingCount = Purchase.getPending().length;
  const userStats = User.getStats();
  
  const text = [
    '👑 *Admin Control Panel*',
    '',
    'Welcome to the PixVerifyBot admin dashboard. Select an action below:',
    '',
    `🟢 *Orders Pending:* ${pendingCount}`,
    `👥 *Monthly Active Users:* ${userStats.monthlyUsers}`,
  ].join('\n');

  const keyboard = { inline_keyboard: [
    [{ text: '📊 Global Statistics', callback_data: CALLBACKS.ADMIN_STATS }],
    [{ text: `📦 Pending Orders (${pendingCount})`, callback_data: 'adm_orders_list' }],
    [{ text: '❓ Help / Commands', callback_data: 'adm_help' }]
  ]};

  if (messageId) {
    try {
      await bot.editMessageText(text, { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown', reply_markup: keyboard });
    } catch {}
  } else {
    await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: keyboard });
  }
}

async function showAdminHelp(bot, chatId, messageId) {
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
    '`/ban <userId>` — Shadow ban a user',
    '`/unban <userId>` — Remove shadow ban',
    '`/banlist` — List shadow banned users',
    '`/apistatus` — API server health & devices',
    '`/apibalance` — Check API key balance',
    '`/maintenance` — Toggle maintenance mode',
    '`/health` — Quick API health check'
  ].join('\n');
  try {
    await bot.editMessageText(helpText, {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [[{ text: '⬅️ Back to Panel', callback_data: CALLBACKS.ADMIN_MENU }]] }
    });
  } catch {}
}

async function showStats(bot, chatId, messageId) {
  const userStats = User.getStats();
  const purchaseStats = Purchase.getStats();

  const text = [
    '📊 *Global Statistics*',
    '',
    '👥 *Users*',
    `• Total Users: *${userStats.totalUsers}*`,
    `• Monthly Active: *${userStats.monthlyUsers}*`,
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

  const MAX_LEN = 3800; // stay well under Telegram's 4096 limit
  const header = '📋 *Pending Orders*\n\n';
  const footer = '\nTo confirm: `/confirm <order_id>`\nTo manually reject: `/reject <order_id>`';
  const keyboard = { inline_keyboard: [
    [{ text: '🔄 Refresh', callback_data: 'adm_orders_list' }],
    [{ text: '⬅️ Back to Panel', callback_data: CALLBACKS.ADMIN_MENU }]
  ]};

  // Build individual order entries
  const entries = pending.map(p => {
    const user = User.findById(p.telegram_user_id);
    const username = user?.username ? `@${escapeMarkdownV1(user.username)}` : 'N/A';
    let entry = `*#${p.id}* — ${username} (\`${p.telegram_user_id}\`)\n`;
    entry += `  💰 $${p.amount} → ${p.credits_added} credits\n`;
    entry += `  📱 ${escapeMarkdownV1(p.payment_method || p.payment_provider || 'N/A')}\n`;
    if (p.unique_amount) entry += `  🔢 Unique: $${p.unique_amount}\n`;
    entry += `  🕐 ${formatDate(p.created_at)}\n`;
    return entry;
  });

  // Chunk entries so each message stays under MAX_LEN
  const chunks = [];
  let current = '';
  for (const entry of entries) {
    if (current.length + entry.length + header.length + footer.length > MAX_LEN && current.length > 0) {
      chunks.push(current);
      current = '';
    }
    current += entry + '\n';
  }
  if (current.length > 0) chunks.push(current);

  const totalPages = chunks.length;
  let isFirst = true;

  for (let i = 0; i < chunks.length; i++) {
    const pageLabel = totalPages > 1 ? `_(Page ${i + 1}/${totalPages})_\n` : '';
    const text = header + pageLabel + chunks[i] + (i === chunks.length - 1 ? footer : '');
    const opts = {
      parse_mode: 'Markdown',
      ...(i === chunks.length - 1 ? { reply_markup: keyboard } : {}),
    };

    if (isFirst && messageId) {
      await bot.editMessageText(text, { chat_id: chatId, message_id: messageId, ...opts });
    } else {
      await bot.sendMessage(chatId, text, opts);
    }
    isFirst = false;
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
  const username = user?.username ? `@${escapeMarkdownV1(user.username)}` : `ID:${purchase.telegram_user_id}`;
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

  // Enforce the 2-minute confirmation timeout
  const confirmKey = `admin_confirm_${orderId}_${adminId}`;
  if (!pendingConfirmations.has(confirmKey)) {
    return bot.answerCallbackQuery(query.id, { text: '⏱️ Confirmation expired. Use /confirm again.' });
  }

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

  // Clean up the pending confirmation entry
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
    } catch {}
  }
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

  const currentBalance = CreditService.getBalance(userId);
  const username = user.username ? `@${escapeMarkdownV1(user.username)}` : `ID:${userId}`;
  const actionKey = `addcr_${adminId}_${userId}_${Date.now()}`;

  pendingConfirmations.set(actionKey, { type: 'add', userId, amount, adminId });
  setTimeout(() => pendingConfirmations.delete(actionKey), 2 * 60 * 1000);

  await bot.sendMessage(chatId, [
    '➕ *Add Credits — Confirm*',
    '',
    `👤 *User:* ${username} (ID: \`${userId}\`)`,
    `💰 *Current balance:* ${currentBalance} credits`,
    `➕ *Amount to add:* ${amount} credits`,
    `📊 *New balance will be:* ${currentBalance + amount} credits`,
    '',
    '⚠️ *Proceed?*',
  ].join('\n'), {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [[
        { text: '✅ Yes, add credits', callback_data: `adm_addcr_yes_${actionKey}` },
        { text: '❌ Cancel', callback_data: `adm_addcr_no_${actionKey}` },
      ]],
    },
  });
}

async function executeAddCredits(bot, query) {
  const actionKey = query.data.replace('adm_addcr_yes_', '');
  const action = pendingConfirmations.get(actionKey);
  if (!action) {
    return bot.answerCallbackQuery(query.id, { text: 'This action has expired.' });
  }
  if (query.from.id !== action.adminId) {
    return bot.answerCallbackQuery(query.id, { text: '⚠️ Only the admin who initiated this can confirm.' });
  }
  pendingConfirmations.delete(actionKey);

  CreditService.addCredits(action.userId, action.amount);
  const newBalance = CreditService.getBalance(action.userId);
  const user = User.findById(action.userId);
  const username = user?.username ? `@${escapeMarkdownV1(user.username)}` : `ID:${action.userId}`;

  logger.info('Admin added credits', { adminId: action.adminId, userId: action.userId, amount: action.amount, newBalance });

  await bot.answerCallbackQuery(query.id, { text: '✅ Credits added!' });

  try {
    await bot.editMessageText(
      `✅ Added *${action.amount}* credits to ${username}.\nNew balance: *${newBalance}*`,
      { chat_id: query.message.chat.id, message_id: query.message.message_id, parse_mode: 'Markdown' }
    );
  } catch {}

  try {
    await bot.sendMessage(action.userId, `💰 *${action.amount} credits* have been added to your account by an admin.\nNew balance: *${newBalance}*`, { parse_mode: 'Markdown' });
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

  const currentBalance = CreditService.getBalance(userId);
  if (currentBalance < amount) {
    return bot.sendMessage(chatId, `⚠️ Cannot remove *${amount}* credits. User only has *${currentBalance}* credits.`, { parse_mode: 'Markdown' });
  }

  const username = user.username ? `@${escapeMarkdownV1(user.username)}` : `ID:${userId}`;
  const actionKey = `rmcr_${adminId}_${userId}_${Date.now()}`;

  pendingConfirmations.set(actionKey, { type: 'remove', userId, amount, adminId });
  setTimeout(() => pendingConfirmations.delete(actionKey), 2 * 60 * 1000);

  await bot.sendMessage(chatId, [
    '➖ *Remove Credits — Confirm*',
    '',
    `👤 *User:* ${username} (ID: \`${userId}\`)`,
    `💰 *Current balance:* ${currentBalance} credits`,
    `➖ *Amount to remove:* ${amount} credits`,
    `📊 *New balance will be:* ${currentBalance - amount} credits`,
    '',
    '⚠️ *Proceed?*',
  ].join('\n'), {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [[
        { text: '✅ Yes, remove credits', callback_data: `adm_rmcr_yes_${actionKey}` },
        { text: '❌ Cancel', callback_data: `adm_rmcr_no_${actionKey}` },
      ]],
    },
  });
}

async function executeRemoveCredits(bot, query) {
  const actionKey = query.data.replace('adm_rmcr_yes_', '');
  const action = pendingConfirmations.get(actionKey);
  if (!action) {
    return bot.answerCallbackQuery(query.id, { text: 'This action has expired.' });
  }
  if (query.from.id !== action.adminId) {
    return bot.answerCallbackQuery(query.id, { text: '⚠️ Only the admin who initiated this can confirm.' });
  }
  pendingConfirmations.delete(actionKey);

  const success = CreditService.removeCredits(action.userId, action.amount);
  if (!success) {
    const currentBalance = CreditService.getBalance(action.userId);
    await bot.answerCallbackQuery(query.id, { text: 'Insufficient balance!' });
    try {
      await bot.editMessageText(
        `⚠️ Cannot remove *${action.amount}* credits. User only has *${currentBalance}* credits.`,
        { chat_id: query.message.chat.id, message_id: query.message.message_id, parse_mode: 'Markdown' }
      );
    } catch {}
    return;
  }

  const newBalance = CreditService.getBalance(action.userId);
  const user = User.findById(action.userId);
  const username = user?.username ? `@${escapeMarkdownV1(user.username)}` : `ID:${action.userId}`;

  logger.info('Admin removed credits', { adminId: action.adminId, userId: action.userId, amount: action.amount, newBalance });

  await bot.answerCallbackQuery(query.id, { text: '✅ Credits removed!' });

  try {
    await bot.editMessageText(
      `✅ Removed *${action.amount}* credits from ${username}.\nNew balance: *${newBalance}*`,
      { chat_id: query.message.chat.id, message_id: query.message.message_id, parse_mode: 'Markdown' }
    );
  } catch {}

  try {
    await bot.sendMessage(action.userId, `💸 *${action.amount} credits* have been removed from your account by an admin.\nNew balance: *${newBalance}*`, { parse_mode: 'Markdown' });
  } catch {}
}

async function cancelCreditAction(bot, query, prefix) {
  const actionKey = query.data.replace(prefix, '');
  pendingConfirmations.delete(actionKey);
  await bot.answerCallbackQuery(query.id, { text: 'Cancelled' });
  try {
    await bot.editMessageText('🚫 Action cancelled.', {
      chat_id: query.message.chat.id,
      message_id: query.message.message_id,
    });
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
  const username = user.username ? `@${escapeMarkdownV1(user.username)}` : 'N/A';
  const firstName = escapeMarkdownV1(user.first_name || 'N/A');

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
// SHADOW BAN MANAGEMENT
// ==========================================

async function shadowBan(bot, chatId, inputUserId) {
  const userId = inputUserId ? parseInt(inputUserId, 10) : null;
  if (!userId) {
    return bot.sendMessage(chatId, '⚠️ Usage: `/ban <telegram_user_id>`', { parse_mode: 'Markdown' });
  }

  const user = User.findById(userId);
  const username = user?.username ? `@${escapeMarkdownV1(user.username)}` : `ID:${userId}`;

  const added = ShadowBanService.ban(userId);
  if (!added) {
    return bot.sendMessage(chatId, `⚠️ User ${username} (\`${userId}\`) is already shadow banned.`, { parse_mode: 'Markdown' });
  }

  await bot.sendMessage(chatId, `🔇 User ${username} (\`${userId}\`) has been shadow banned.`, { parse_mode: 'Markdown' });
}

async function shadowUnban(bot, chatId, inputUserId) {
  const userId = inputUserId ? parseInt(inputUserId, 10) : null;
  if (!userId) {
    return bot.sendMessage(chatId, '⚠️ Usage: `/unban <telegram_user_id>`', { parse_mode: 'Markdown' });
  }

  const user = User.findById(userId);
  const username = user?.username ? `@${escapeMarkdownV1(user.username)}` : `ID:${userId}`;

  const removed = ShadowBanService.unban(userId);
  if (!removed) {
    return bot.sendMessage(chatId, `⚠️ User ${username} (\`${userId}\`) is not shadow banned.`, { parse_mode: 'Markdown' });
  }

  await bot.sendMessage(chatId, `🔊 User ${username} (\`${userId}\`) has been unbanned.`, { parse_mode: 'Markdown' });
}

async function showBanList(bot, chatId) {
  const banned = ShadowBanService.getAll();

  if (banned.length === 0) {
    return bot.sendMessage(chatId, '📋 *Shadow Ban List*\n\nNo users are currently shadow banned.', { parse_mode: 'Markdown' });
  }

  const lines = banned.map(id => {
    const user = User.findById(id);
    const username = user?.username ? `@${escapeMarkdownV1(user.username)}` : 'N/A';
    return `• \`${id}\` — ${username}`;
  });

  const msg = [
    `🔇 *Shadow Ban List* (${banned.length})`,
    '',
    ...lines,
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
