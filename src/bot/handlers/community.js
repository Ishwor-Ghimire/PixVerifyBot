const config = require('../../config');
const { MESSAGES } = require('../../utils/constants');

function register(bot) {
  bot.onText(/\/community/, async (msg) => {
    const text = MESSAGES.COMMUNITY.replace('{link}', config.links.community);
    await bot.sendMessage(msg.chat.id, text, { parse_mode: 'Markdown' });
  });
}

module.exports = { register };
