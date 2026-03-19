const config = require('../../config');
const { MESSAGES } = require('../../utils/constants');

// In-memory rate limit store: userId -> { count, resetAt }
const stores = {
  general: new Map(),
  run: new Map(),
};

function checkLimit(store, userId, maxRequests, windowMs) {
  const now = Date.now();
  const entry = store.get(userId);

  if (!entry || now > entry.resetAt) {
    store.set(userId, { count: 1, resetAt: now + windowMs });
    return true;
  }

  if (entry.count >= maxRequests) {
    return false;
  }

  entry.count++;
  return true;
}

// Clean up expired entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const store of Object.values(stores)) {
    for (const [key, entry] of store) {
      if (now > entry.resetAt) store.delete(key);
    }
  }
}, 5 * 60 * 1000);

/**
 * General rate limiter middleware
 */
function withRateLimit(handler) {
  return async (bot, msg, ...args) => {
    const userId = msg.from?.id;
    if (!userId) return;

    const allowed = checkLimit(
      stores.general,
      userId,
      config.rateLimit.maxRequests,
      config.rateLimit.windowMs
    );

    if (!allowed) {
      return bot.sendMessage(msg.chat.id, MESSAGES.RATE_LIMITED);
    }

    return handler(bot, msg, ...args);
  };
}

/**
 * Stricter rate limiter for /run command
 */
function withRunRateLimit(handler) {
  return async (bot, msg, ...args) => {
    const userId = msg.from?.id;
    if (!userId) return;

    const allowed = checkLimit(
      stores.run,
      userId,
      config.rateLimit.runMax,
      config.rateLimit.windowMs
    );

    if (!allowed) {
      return bot.sendMessage(msg.chat.id, '⏱️ Too many generation requests. Please wait a minute.');
    }

    return handler(bot, msg, ...args);
  };
}

module.exports = { withRateLimit, withRunRateLimit };
