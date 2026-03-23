const { MESSAGES } = require('../../utils/constants');
const User = require('../../db/models/User');
const ReferralService = require('../../services/referralService');
const config = require('../../config');

// Cache the bot username at registration time
let cachedBotUsername = null;

function register(bot) {
  // Resolve bot username once at startup
  bot.getMe().then(me => { cachedBotUsername = me.username; }).catch(() => {});

  bot.onText(/\/refer/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;

    // Ensure user exists
    User.findOrCreate(msg.from);

    // Get bot username — use cache, or fetch if not yet cached
    if (!cachedBotUsername) {
      try {
        const me = await bot.getMe();
        cachedBotUsername = me.username;
      } catch {
        return bot.sendMessage(chatId, '⚠️ Could not generate referral link. Please try again.');
      }
    }

    const link = ReferralService.getReferralLink(cachedBotUsername, userId);
    const stats = ReferralService.getReferralStats(userId);

    const text = MESSAGES.REFERRAL_STATS
      .replace('{link}', link)
      .replace('{total}', stats.total)
      .replace('{successful}', stats.successful)
      .replace('{pending}', stats.pending)
      .replace('{totalRewards}', stats.totalRewards)
      .replace('{rewardPerReferral}', stats.rewardPerReferral)
      .replace('{minTopUp}', config.referral.minTopUpCredits);

    await bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
  });
}

module.exports = { register };
