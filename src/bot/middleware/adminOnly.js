const User = require('../../db/models/User');
const { MESSAGES } = require('../../utils/constants');

/**
 * Restricts handler to admin users only
 */
function adminOnly(handler) {
  return async (bot, msg, ...args) => {
    const userId = msg.from?.id;
    if (!userId || !User.isAdmin(userId)) {
      return bot.sendMessage(msg.chat.id, MESSAGES.ADMIN_ONLY);
    }
    return handler(bot, msg, ...args);
  };
}

module.exports = { adminOnly };
