const QueueService = require('../../services/queueService');
const { MESSAGES } = require('../../utils/constants');

function register(bot) {
  bot.onText(/\/queue/, async (msg) => {
    const statusMsg = await bot.sendMessage(msg.chat.id, '🔄 Checking queue...');

    const queue = await QueueService.getStatus();

    let text = MESSAGES.QUEUE_HEADER + '\n';

    if (!queue.ok) {
      text += '❌ Unable to fetch queue status.\n';
      text += `Error: ${queue.error}`;
    } else {
      text += `🔵 *Active Jobs:* ${queue.activeJobs}\n`;
      text += `🟠 *Pending:* ${queue.pendingJobs}\n`;
      text += `📱 *Devices:* ${queue.devicesReady}/${queue.devicesTotal} ready\n`;
      text += `⏱️ *Est. per job:* ~${queue.estimatedTimePerJob}s\n`;
      text += `⏳ *Estimated wait:* ${queue.estimatedWait}`;
    }

    await bot.editMessageText(text, {
      chat_id: msg.chat.id,
      message_id: statusMsg.message_id,
      parse_mode: 'Markdown',
    });
  });
}

module.exports = { register };
