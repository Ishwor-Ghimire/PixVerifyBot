const config = require('../../config');
const { MESSAGES } = require('../../utils/constants');

function register(bot) {
  bot.onText(/\/support/, async (msg) => {
    const text = MESSAGES.SUPPORT.replace('{contact}', config.links.support);
    await bot.sendMessage(msg.chat.id, text, { parse_mode: 'Markdown' });
  });
}

module.exports = { register };
