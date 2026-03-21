const TelegramBot = require('node-telegram-bot-api');
const config = require('../config');
const logger = require('../utils/logger');
const User = require('../db/models/User');
const { CALLBACKS } = require('../utils/constants');

// Import handlers
const startHandler = require('./handlers/start');
const runHandler = require('./handlers/run');
const balanceHandler = require('./handlers/balance');
const buyHandler = require('./handlers/buy');
const communityHandler = require('./handlers/community');
const historyHandler = require('./handlers/history');
const healthHandler = require('./handlers/health');
const queueHandler = require('./handlers/queue');
const supportHandler = require('./handlers/support');
const menuHandler = require('./handlers/menu');
const helpHandler = require('./handlers/help');
const adminHandler = require('./handlers/admin');

function createBot() {
  const bot = new TelegramBot(config.bot.token, { polling: true });

  /**
   * Build subscription block message and keyboard for channels the user hasn't joined.
   */
  function buildSubscriptionUI(unjoinedChannels) {
    const buttons = unjoinedChannels.map(ch => {
      const label = ch.replace(/^@/, '');
      return [{ text: `🌐 Join ${label}`, url: `https://t.me/${label}` }];
    });
    buttons.push([{ text: '✅ I have joined. Check now', callback_data: 'check_sub' }]);

    return {
      message: [
        '⚠️ *Access Denied*',
        '',
        'You must join all our official channels before using this bot:',
        '',
        ...unjoinedChannels.map(ch => `👉 [${ch.replace(/^@/, '')}](https://t.me/${ch.replace(/^@/, '')})`),
      ].join('\n'),
      keyboard: { inline_keyboard: buttons },
    };
  }

  async function promptChannelJoin(update, alertText, unjoinedChannels) {
    const msg = update.message || update.callback_query?.message;
    if (!msg?.chat?.id) return;

    if (update.callback_query) {
      await bot.answerCallbackQuery(update.callback_query.id, {
        text: alertText,
        show_alert: true,
      });
      return;
    }

    const ui = buildSubscriptionUI(unjoinedChannels);
    await bot.sendMessage(msg.chat.id, ui.message, {
      parse_mode: 'Markdown',
      disable_web_page_preview: true,
      reply_markup: ui.keyboard,
    });
  }

  // Intercept all updates to enforce mandatory channel subscription
  const originalProcessUpdate = bot.processUpdate.bind(bot);
  bot.processUpdate = async (update) => {
    try {
      const msg = update.message || update.callback_query?.message;
      const userId = update.message?.from?.id || update.callback_query?.from?.id;
      const chatId = msg?.chat?.id;
      const requiredChannels = config.bot.requiredChannels;

      if (userId && chatId && requiredChannels.length > 0) {
        // Skip channel check for bot admins
        if (!config.admin.userIds.includes(Number(userId))) {
          try {
            // Check ALL required channels
            const unjoinedChannels = [];
            for (const channel of requiredChannels) {
              const member = await bot.getChatMember(channel, userId);
              if (!['member', 'administrator', 'creator', 'restricted'].includes(member.status)) {
                unjoinedChannels.push(channel);
              }
            }

            if (unjoinedChannels.length > 0) {
              await promptChannelJoin(
                update,
                update.callback_query?.data === 'check_sub'
                  ? 'You have not joined all required channels yet.'
                  : 'You must join all required channels first.',
                unjoinedChannels
              );
              return; // Stop processing this update completely
            }
          } catch (err) {
            logger.warn('Channel check failed; blocking access', {
              error: err.message,
              channels: requiredChannels,
            });
            await promptChannelJoin(
              update,
              'Membership check is unavailable right now. Ask admin to verify the channel setup.',
              requiredChannels
            );
            return;
          }
        }
      }
    } catch (e) {
      logger.error('Error in processUpdate interceptor', { error: e.message });
    }

    return originalProcessUpdate(update);
  };


  // Global error handlers
  bot.on('polling_error', (err) => {
    logger.error('Polling error', { error: err.message });
  });

  bot.on('error', (err) => {
    logger.error('Bot error', { error: err.message });
  });

  // Auto-register users on any message
  bot.on('message', (msg) => {
    if (msg.from) {
      try {
        User.findOrCreate(msg.from);
      } catch (err) {
        logger.error('User registration error', { error: err.message });
      }
    }
  });

  // Register all command handlers
  startHandler.register(bot);
  runHandler.register(bot);
  balanceHandler.register(bot);
  buyHandler.register(bot);
  communityHandler.register(bot);
  historyHandler.register(bot);
  healthHandler.register(bot);
  queueHandler.register(bot);
  supportHandler.register(bot);
  menuHandler.register(bot);
  helpHandler.register(bot);
  adminHandler.register(bot);

  // Handle menu callback routing
  bot.on('callback_query', async (query) => {
    if (query.data === 'check_sub') {
      await bot.answerCallbackQuery(query.id, { text: '✅ Verified! Welcome.' });
      try { await bot.deleteMessage(query.message.chat.id, query.message.message_id); } catch {}
      
      const fakeMsg = { chat: query.message.chat, from: query.from, message_id: query.message.message_id, text: '/start' };
      bot.processUpdate({ message: { ...fakeMsg, text: '/start', date: Date.now() } });
      return;
    }

    if (!query.data?.startsWith(CALLBACKS.MENU_ACTION)) return;

    const action = query.data.replace(CALLBACKS.MENU_ACTION, '');
    await bot.answerCallbackQuery(query.id);

    // Simulate command by creating a synthetic message
    const fakeMsg = {
      chat: query.message.chat,
      from: query.from,
      message_id: query.message.message_id,
      text: `/${action}`,
    };

    switch (action) {
      case 'run':
        bot.emit('text', fakeMsg, [fakeMsg.text]); // Triggers /run regex
        bot.processUpdate({ message: { ...fakeMsg, text: '/run', date: Date.now() } });
        break;
      case 'balance':
        bot.processUpdate({ message: { ...fakeMsg, text: '/balance', date: Date.now() } });
        break;
      case 'buy':
        bot.processUpdate({ message: { ...fakeMsg, text: '/buy', date: Date.now() } });
        break;
      case 'history':
        bot.processUpdate({ message: { ...fakeMsg, text: '/myhistory', date: Date.now() } });
        break;
      case 'queue':
        bot.processUpdate({ message: { ...fakeMsg, text: '/queue', date: Date.now() } });
        break;
      case 'community':
        bot.processUpdate({ message: { ...fakeMsg, text: '/community', date: Date.now() } });
        break;
      case 'support':
        bot.processUpdate({ message: { ...fakeMsg, text: '/support', date: Date.now() } });
        break;
      case 'help':
        bot.processUpdate({ message: { ...fakeMsg, text: '/help', date: Date.now() } });
        break;
    }
  });

  // Register slash commands with Telegram so they appear in the command menu
  bot.setMyCommands([
    { command: 'start', description: 'Welcome & main menu' },
    { command: 'run', description: 'Start verification' },
    { command: 'balance', description: 'Check your credits' },
    { command: 'buy', description: 'Purchase credits' },
    { command: 'myhistory', description: 'View past generations' },
    { command: 'queue', description: 'Check queue status' },
    { command: 'community', description: 'Join our community' },
    { command: 'support', description: 'Get help' },
    { command: 'menu', description: 'Main menu' },
    { command: 'help', description: 'How to use the bot' },
  ]).catch(err => logger.warn('Failed to set bot commands', { error: err.message }));

  logger.info('Bot initialized and polling');
  return bot;
}

module.exports = { createBot };
