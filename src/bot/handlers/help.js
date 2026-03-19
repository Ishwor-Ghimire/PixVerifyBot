const { MESSAGES } = require('../../utils/constants');

function register(bot) {
  bot.onText(/\/help/, async (msg) => {
    await bot.sendMessage(msg.chat.id, MESSAGES.HELP, { parse_mode: 'Markdown' });
  });
}

module.exports = { register };
