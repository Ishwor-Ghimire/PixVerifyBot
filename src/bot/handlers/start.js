const { MESSAGES, CALLBACKS } = require('../../utils/constants');

function register(bot) {
  bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
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
          { text: '🛟 Support', callback_data: `${CALLBACKS.MENU_ACTION}support` },
          { text: '📖 Help', callback_data: `${CALLBACKS.MENU_ACTION}help` },
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
