const { CALLBACKS } = require('../../utils/constants');

function register(bot) {
  bot.onText(/\/menu/, async (msg) => {
    const keyboard = {
      reply_markup: {
        inline_keyboard: [
          [
            { text: '🚀 Generate Link', callback_data: `${CALLBACKS.MENU_ACTION}run` },
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
      },
    };

    await bot.sendMessage(msg.chat.id, '📱 *Main Menu*\n\nChoose an action:', {
      parse_mode: 'Markdown',
      ...keyboard,
    });
  });
}

module.exports = { register };
