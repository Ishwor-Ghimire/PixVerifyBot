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

  // Intercept all updates to enforce mandatory channel subscription
  const originalProcessUpdate = bot.processUpdate.bind(bot);
  bot.processUpdate = async (update) => {
    try {
      const msg = update.message || update.callback_query?.message;
      const userId = update.message?.from?.id || update.callback_query?.from?.id;
      const chatId = msg?.chat?.id;

      if (userId && chatId && config.bot.requiredChannel) {
        // Skip channel check for bot admins
        if (!config.admin.userIds.includes(userId)) {
          try {
            const member = await bot.getChatMember(config.bot.requiredChannel, userId);
            if (member.status === 'left' || member.status === 'kicked') {
              const blockMsg = `⚠️ *Access Denied*\n\nYou must join our official channel to use this bot.\n\n👉 **[Join our Channel](${config.links.community})**\n\nAfter joining, try your command again.`;
              
              if (update.callback_query) {
                await bot.answerCallbackQuery(update.callback_query.id, { text: 'You must join the channel first!', show_alert: true });
              } else {
                await bot.sendMessage(chatId, blockMsg, { parse_mode: 'Markdown', disable_web_page_preview: true });
              }
              return; // Stop processing this update completely
            }
          } catch (err) {
            logger.warn('Channel check failed (ensure bot is admin in channel)', { error: err.message, channel: config.bot.requiredChannel });
            // Fail open if the bot doesn't have privileges or channel doesn't exist
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
        // Re-emit as message with /run text for onText to pick up
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

  logger.info('Bot initialized and polling');
  return bot;
}

module.exports = { createBot };
