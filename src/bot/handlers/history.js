const GenerationService = require('../../services/generationService');
const { MESSAGES, STATUS_LABELS, CALLBACKS } = require('../../utils/constants');
const { formatDate, truncate } = require('../../utils/helpers');

const ITEMS_PER_PAGE = 5;

function register(bot) {
  bot.onText(/\/myhistory/, async (msg) => {
    await sendHistoryPage(bot, msg.chat.id, msg.from.id, 1);
  });

  // Handle pagination
  bot.on('callback_query', async (query) => {
    if (!query.data?.startsWith(CALLBACKS.HISTORY_PAGE)) return;

    const page = parseInt(query.data.replace(CALLBACKS.HISTORY_PAGE, ''), 10);
    await bot.answerCallbackQuery(query.id);
    await sendHistoryPage(bot, query.message.chat.id, query.from.id, page, query.message.message_id);
  });
}

async function sendHistoryPage(bot, chatId, userId, page, editMessageId = null) {
  const { records, total, totalPages } = GenerationService.getHistory(userId, page, ITEMS_PER_PAGE);

  if (total === 0) {
    const text = MESSAGES.HISTORY_EMPTY;
    if (editMessageId) {
      return bot.editMessageText(text, { chat_id: chatId, message_id: editMessageId });
    }
    return bot.sendMessage(chatId, text);
  }

  let text = MESSAGES.HISTORY_HEADER + '\n';
  records.forEach((gen, i) => {
    const num = (page - 1) * ITEMS_PER_PAGE + i + 1;
    const status = STATUS_LABELS[gen.status] || gen.status;
    const url = gen.result_url ? `\n   🔗 ${truncate(gen.result_url, 50)}` : '';
    const error = gen.error_code ? `\n   ⚠️ ${gen.error_code}` : '';

    text += `*${num}.* ${gen.email}\n`;
    text += `   ${status} · ${formatDate(gen.created_at)}${url}${error}\n\n`;
  });

  text += `📄 Page ${page}/${totalPages} (${total} total)`;

  // Build pagination buttons
  const buttons = [];
  if (page > 1) {
    buttons.push({ text: '⬅️ Prev', callback_data: `${CALLBACKS.HISTORY_PAGE}${page - 1}` });
  }
  if (page < totalPages) {
    buttons.push({ text: 'Next ➡️', callback_data: `${CALLBACKS.HISTORY_PAGE}${page + 1}` });
  }

  const opts = {
    parse_mode: 'Markdown',
    reply_markup: buttons.length > 0 ? { inline_keyboard: [buttons] } : undefined,
  };

  if (editMessageId) {
    return bot.editMessageText(text, { chat_id: chatId, message_id: editMessageId, ...opts });
  }
  return bot.sendMessage(chatId, text, opts);
}

module.exports = { register };
