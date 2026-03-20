const GenerationService = require('../../services/generationService');
const CreditService = require('../../services/creditService');
const config = require('../../config');
const { MESSAGES, CALLBACKS } = require('../../utils/constants');
const { isValidEmail, isValidTotpSecret, maskString, formatDuration, generateProgressBar } = require('../../utils/helpers');
const logger = require('../../utils/logger');

// Conversation state tracking per user
const sessions = new Map();

// Conversation stages
const STAGE = {
  ASK_EMAIL: 'ask_email',
  ASK_PASSWORD: 'ask_password',
  ASK_TOTP: 'ask_totp',
  CONFIRM: 'confirm',
  PROCESSING: 'processing',
};

function register(bot) {
  // /run command — start generation flow
  bot.onText(/\/run/, async (msg) => {
    const userId = msg.from.id;
    const chatId = msg.chat.id;

    // Check for active generation
    if (GenerationService.hasActiveGeneration(userId)) {
      return bot.sendMessage(chatId, MESSAGES.ALREADY_RUNNING);
    }

    // Check if user already in a session
    if (sessions.has(userId) && sessions.get(userId).stage === STAGE.PROCESSING) {
      return bot.sendMessage(chatId, MESSAGES.ALREADY_RUNNING);
    }

    // Admin check
    const isAdmin = config.admin.userIds.includes(userId);

    // Check balance (skip for admin)
    if (!isAdmin) {
      const balance = CreditService.getBalance(userId);
      if (balance < 1) {
        return bot.sendMessage(chatId, MESSAGES.INSUFFICIENT_CREDITS);
      }
    }

    // Start conversation
    sessions.set(userId, { stage: STAGE.ASK_EMAIL, chatId });
    await bot.sendMessage(chatId, MESSAGES.RUN_START, { parse_mode: 'Markdown' });
  });

  // Handle text messages for conversational flow
  bot.on('message', async (msg) => {
    if (!msg.text || msg.text.startsWith('/')) return;

    const userId = msg.from.id;
    const chatId = msg.chat.id;
    const session = sessions.get(userId);

    if (!session || session.chatId !== chatId) return;

    switch (session.stage) {
      case STAGE.ASK_EMAIL:
        await handleEmail(bot, msg, session);
        break;
      case STAGE.ASK_PASSWORD:
        await handlePassword(bot, msg, session);
        break;
      case STAGE.ASK_TOTP:
        await handleTotp(bot, msg, session);
        break;
    }
  });

  // Handle confirm/cancel callbacks
  bot.on('callback_query', async (query) => {
    if (query.data === CALLBACKS.CONFIRM_RUN) {
      await handleConfirm(bot, query);
    } else if (query.data === CALLBACKS.CANCEL_RUN) {
      await handleCancel(bot, query);
    }
  });
}

async function handleEmail(bot, msg, session) {
  const email = msg.text.trim();

  if (!isValidEmail(email)) {
    return bot.sendMessage(msg.chat.id, MESSAGES.INVALID_EMAIL);
  }

  // Delete user's message containing email for privacy
  try { await bot.deleteMessage(msg.chat.id, msg.message_id); } catch {}

  session.email = email;
  session.stage = STAGE.ASK_PASSWORD;
  await bot.sendMessage(msg.chat.id, MESSAGES.RUN_ASK_PASSWORD, { parse_mode: 'Markdown' });
}

async function handlePassword(bot, msg, session) {
  const password = msg.text.trim();

  if (!password || password.length > 256) {
    return bot.sendMessage(msg.chat.id, '⚠️ Invalid password. Please try again:');
  }

  // Delete user's message containing password for privacy
  try { await bot.deleteMessage(msg.chat.id, msg.message_id); } catch {}

  session.password = password;
  session.stage = STAGE.ASK_TOTP;
  await bot.sendMessage(msg.chat.id, MESSAGES.RUN_ASK_TOTP, { parse_mode: 'Markdown' });
}

async function handleTotp(bot, msg, session) {
  const totp = msg.text.trim();

  if (!isValidTotpSecret(totp)) {
    return bot.sendMessage(msg.chat.id, MESSAGES.INVALID_TOTP);
  }

  // Delete user's message for privacy
  try { await bot.deleteMessage(msg.chat.id, msg.message_id); } catch {}

  session.totp = totp;
  session.stage = STAGE.CONFIRM;

  // Show confirmation
  const confirmText = [
    MESSAGES.RUN_CONFIRM,
    '',
    `📧 Email: ${maskString(session.email)}`,
    `🔑 Password: ••••••••`,
    `🔐 TOTP: ${maskString(session.totp)}`,
  ].join('\n');

  await bot.sendMessage(msg.chat.id, confirmText, {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [[
        { text: '✅ Confirm', callback_data: CALLBACKS.CONFIRM_RUN },
        { text: '❌ Cancel', callback_data: CALLBACKS.CANCEL_RUN },
      ]],
    },
  });
}

async function handleConfirm(bot, query) {
  const userId = query.from.id;
  const chatId = query.message.chat.id;
  const session = sessions.get(userId);

  if (!session || session.stage !== STAGE.CONFIRM) {
    return bot.answerCallbackQuery(query.id, { text: 'Session expired. Use /run again.' });
  }

  await bot.answerCallbackQuery(query.id);

  // Remove confirmation buttons
  try {
    await bot.editMessageReplyMarkup(
      { inline_keyboard: [] },
      { chat_id: chatId, message_id: query.message.message_id }
    );
  } catch {}

  session.stage = STAGE.PROCESSING;

  // Send initial status
  const statusMsg = await bot.sendMessage(chatId, MESSAGES.RUN_SUBMITTED);

  const isAdmin = config.admin.userIds.includes(userId);
  let lastProgressText = '';
  const localStartTime = Date.now();

  try {
    const result = await GenerationService.startGeneration(
      userId,
      session.email,
      session.password,
      session.totp,
      // Progress callback — shows queue position, progress bar, stage label
      async (status) => {
        let progressMsg = '';

        if (status.status === 'background') {
          // Switched to background polling
          progressMsg = MESSAGES.BACKGROUND_POLLING;
        } else if (status.status === 'queued') {
          const pos = status.queue_position ?? '...';
          const wait = status.estimated_wait_seconds ?? '...';
          progressMsg = [
            `⏳ *Queued...*`,
            '',
            `📧 ${maskString(session.email)}`,
            `📊 Position: #${pos}`,
            `⏱️ Est. wait: ~${wait}s`,
          ].join('\n');
        } else if (status.status === 'running') {
          const bar = generateProgressBar(status.stage, status.total_stages);
          const localElapsed = (Date.now() - localStartTime) / 1000;
          progressMsg = [
            `⚙️ *Processing...*`,
            '',
            `📧 ${maskString(session.email)}`,
            `${bar}`,
            `🔄 ${status.stage_label || 'Working...'}`,
            `⏱️ ${formatDuration(localElapsed)}`,
          ].join('\n');
        }

        // Only update if message changed
        if (progressMsg && progressMsg !== lastProgressText) {
          lastProgressText = progressMsg;
          try {
            await bot.editMessageText(progressMsg, {
              chat_id: chatId,
              message_id: statusMsg.message_id,
              parse_mode: 'Markdown',
            });
          } catch {}
        }
      },
      isAdmin
    );

    // Handle result
    if (result.success) {
      const elapsed = result.elapsed ? formatDuration(result.elapsed) : formatDuration((Date.now() - localStartTime) / 1000);
      try {
        await bot.editMessageText(
          `${MESSAGES.RUN_SUCCESS}\n\n🔗 *Link:*\n\`${result.url}\`\n\n⏱️ Completed in ${elapsed}`,
          { chat_id: chatId, message_id: statusMsg.message_id, parse_mode: 'Markdown' }
        );
      } catch (editErr) {
        logger.warn('Could not update success message', { userId, error: editErr.message });
        try {
          await bot.sendMessage(chatId,
            `${MESSAGES.RUN_SUCCESS}\n\n🔗 *Link:*\n\`${result.url}\`\n\n⏱️ Completed in ${elapsed}`,
            { parse_mode: 'Markdown' }
          );
        } catch {}
      }
    } else if (result.error === 'INSUFFICIENT_CREDITS') {
      try {
        await bot.editMessageText(
          MESSAGES.INSUFFICIENT_CREDITS,
          { chat_id: chatId, message_id: statusMsg.message_id }
        );
      } catch {}
    } else if (result.error === 'ALREADY_QUEUED') {
      try {
        await bot.editMessageText(
          '⏳ This email is already being processed. Please wait.',
          { chat_id: chatId, message_id: statusMsg.message_id }
        );
      } catch {}
    } else {
      const errorMsg = getReadableError(result.error);
      const refundNote = isAdmin ? '' : '\n\n💰 Your credit has been refunded.';
      try {
        await bot.editMessageText(
          `${MESSAGES.RUN_FAILED}\n\n${errorMsg}${refundNote}`,
          { chat_id: chatId, message_id: statusMsg.message_id, parse_mode: 'Markdown' }
        );
      } catch (editErr) {
        logger.warn('Could not update error message', { userId, error: editErr.message });
        try {
          await bot.sendMessage(chatId,
            `${MESSAGES.RUN_FAILED}\n\n${errorMsg}${refundNote}`,
            { parse_mode: 'Markdown' }
          );
        } catch {}
      }
    }
  } catch (err) {
    logger.error('Run handler error', { userId, error: err.message, stack: err.stack });

    const refundNote = isAdmin ? '' : '\n\n💰 Your credit has been refunded.';
    try {
      await bot.editMessageText(
        `${MESSAGES.ERROR_GENERIC}${refundNote}`,
        { chat_id: chatId, message_id: statusMsg.message_id }
      );
    } catch {
      try {
        await bot.sendMessage(chatId, `${MESSAGES.ERROR_GENERIC}${refundNote}`);
      } catch {}
    }
  }

  // Clean up session
  sessions.delete(userId);
}

async function handleCancel(bot, query) {
  const userId = query.from.id;
  sessions.delete(userId);
  await bot.answerCallbackQuery(query.id, { text: 'Cancelled' });
  await bot.sendMessage(query.message.chat.id, MESSAGES.RUN_CANCELLED);
}

/**
 * Map API error codes to user-friendly messages
 */
function getReadableError(code) {
  const errors = {
    WRONG_PASSWORD: '🔑 Incorrect password. Please verify and try again.',
    INVALID_EMAIL: '📧 Invalid or non-existent email address.',
    TOTP_ERROR: '🔐 TOTP verification failed. Check your secret key.',
    NO_AUTHENTICATOR: '🔐 No TOTP authenticator set up on this account.',
    CAPTCHA: '🤖 CAPTCHA challenge encountered. Try again later.',
    ACCOUNT_DISABLED: '🚫 This account is disabled or locked.',
    PASSKEY_BLOCKED: '🔒 Account requires Passkey verification (not supported).',
    GOOGLE_ONE_UNAVAILABLE: '❌ This account is not eligible for Google One trial.',
    ALREADY_QUEUED: '⏳ This email is already being processed.',
    ALREADY_PROCESSED: '✅ This email has already been processed.',
    SERVICE_PAUSED: '⏸️ Service is temporarily paused. Try again later.',
    TIMEOUT: '⏰ Request timed out. The job may still be processing.',
    NETWORK_ERROR: '🌐 Cannot reach the generation service.',
    INSUFFICIENT_BALANCE: '💳 API balance insufficient. Contact admin.',
    INTERNAL_ERROR: '⚙️ Internal error. Please try again.',
    HTTP_402: '💳 API balance insufficient. Contact admin.',
    HTTP_409: '⏳ This email is already being processed.',
    HTTP_429: '⏱️ Too many requests. Please wait and try again.',
  };
  return errors[code] || `⚠️ Error: ${code}`;
}

module.exports = { register };
