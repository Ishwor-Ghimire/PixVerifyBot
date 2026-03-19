const User = require('../../db/models/User');
const logger = require('../../utils/logger');

/**
 * Middleware that auto-registers users on first interaction
 * and updates last_active_at on every message.
 * Wraps handler: (bot, msg, ...args) => {}
 */
function withAuth(handler) {
  return async (bot, msg, ...args) => {
    try {
      const telegramUser = msg.from;
      if (!telegramUser) return;

      const user = User.findOrCreate(telegramUser);

      if (user.isNew) {
        logger.info('New user registered', {
          userId: telegramUser.id,
          username: telegramUser.username,
        });
      }

      // Attach user to message for downstream handlers
      msg._user = user;
      return await handler(bot, msg, ...args);
    } catch (err) {
      logger.error('Auth middleware error', { error: err.message, stack: err.stack });
      bot.sendMessage(msg.chat.id, '⚠️ Something went wrong. Please try again.');
    }
  };
}

module.exports = { withAuth };
