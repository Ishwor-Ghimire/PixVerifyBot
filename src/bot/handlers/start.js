const { MESSAGES, CALLBACKS } = require('../../utils/constants');
const User = require('../../db/models/User');
const ReferralService = require('../../services/referralService');
const logger = require('../../utils/logger');

function register(bot) {
  bot.onText(/\/start(?:\s+(.+))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    const payload = match[1]; // deep-link payload, e.g. "ref_12345"

    // Register user
    const user = User.findOrCreate(msg.from);

    // Handle referral deep-link for NEW users only
    if (payload && user.isNew) {
      const referrerId = ReferralService.parseReferralCode(payload);
      if (referrerId) {
        const result = ReferralService.recordReferral(referrerId, msg.from.id);
        if (result.success) {
          logger.info('Referral recorded via deep-link', {
            referrer: referrerId,
            referred: msg.from.id,
          });
        }
      }
    }

    const keyboard = {
      inline_keyboard: [
        [
          { text: '🚀 Start Verification', callback_data: `${CALLBACKS.MENU_ACTION}run` },
          { text: '💰 Balance', callback_data: `${CALLBACKS.MENU_ACTION}balance` },
        ],
        [
          { text: '🛒 Buy Credits', callback_data: `${CALLBACKS.MENU_ACTION}buy` },
          { text: '📋 History', callback_data: `${CALLBACKS.MENU_ACTION}history` },
        ],
        [
          { text: '📊 Queue', callback_data: `${CALLBACKS.MENU_ACTION}queue` },
          { text: '🌐 Community', callback_data: `${CALLBACKS.MENU_ACTION}community` },
        ],
        [
          { text: '🔗 Refer & Earn', callback_data: `${CALLBACKS.MENU_ACTION}refer` },
          { text: '📖 Help', callback_data: `${CALLBACKS.MENU_ACTION}help` },
        ],
        [
          { text: '🛟 Support', callback_data: `${CALLBACKS.MENU_ACTION}support` },
        ],
      ],
    };

    await bot.sendMessage(chatId, MESSAGES.WELCOME, {
      parse_mode: 'Markdown',
      reply_markup: keyboard,
    });
  });
}

module.exports = { register };
