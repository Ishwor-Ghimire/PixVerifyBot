const CreditService = require('../../services/creditService');
const { MESSAGES } = require('../../utils/constants');

function register(bot) {
  bot.onText(/\/balance/, async (msg) => {
    const balance = CreditService.getBalance(msg.from.id);
    const text = MESSAGES.BALANCE_TEMPLATE.replace('{balance}', balance);
    await bot.sendMessage(msg.chat.id, text, { parse_mode: 'Markdown' });
  });
}

module.exports = { register };
