const GoogleOneClient = require('../../api/googleOneClient');
const User = require('../../db/models/User');
const { MESSAGES } = require('../../utils/constants');

function register(bot) {
  bot.onText(/\/health/, async (msg) => {
    // Admin-only check
    if (!User.isAdmin(msg.from.id)) {
      return bot.sendMessage(msg.chat.id, MESSAGES.ADMIN_ONLY);
    }

    const statusMsg = await bot.sendMessage(msg.chat.id, '🔄 Checking system health...');

    const health = await GoogleOneClient.checkHealth();

    let text = MESSAGES.HEALTH_HEADER + '\n';

    if (!health.ok) {
      text += '❌ *API Status:* Unreachable\n';
      text += `Error: ${health.error}`;
    } else {
      text += `✅ *API Status:* ${health.status}\n`;
      text += `📱 *Devices:* ${health.devices_connected}/${health.device_count} connected\n`;

      if (health.pools) {
        for (const [poolName, pool] of Object.entries(health.pools)) {
          text += `\n*Pool: ${poolName}*\n`;
          text += `  Devices: ${pool.device_count}\n`;
          if (pool.devices) {
            pool.devices.forEach(d => {
              const status = d.busy ? '🔵 Busy' : (d.ready ? '🟢 Ready' : '🟡 Preparing');
              text += `  • ${d.serial}: ${status}\n`;
            });
          }
        }
      }

      text += `\n🔌 *Hotplug:* ${health.hotplug ? 'Enabled' : 'Disabled'}`;
    }

    await bot.editMessageText(text, {
      chat_id: msg.chat.id,
      message_id: statusMsg.message_id,
      parse_mode: 'Markdown',
    });
  });
}

module.exports = { register };
