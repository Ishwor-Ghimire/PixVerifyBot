const { MESSAGES } = require('../../utils/constants');

function register(bot) {
  bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    // User auto-registration is handled by auth middleware in bot/index.js
    await bot.sendMessage(chatId, MESSAGES.WELCOME, { parse_mode: 'Markdown' });
  });
}

module.exports = { register };
