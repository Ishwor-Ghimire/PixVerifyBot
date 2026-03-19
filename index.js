const config = require('./src/config');
const logger = require('./src/utils/logger');
const { initDatabase, closeDatabase } = require('./src/db/database');
const { createBot } = require('./src/bot');
const PaymentMonitor = require('./src/services/payments/paymentMonitor');

async function main() {
  logger.info('Starting PixVerifyBot...');

  // Initialize database
  initDatabase();

  // Create and start bot
  const bot = createBot();

  // Start payment monitor (auto-detects incoming payments)
  PaymentMonitor.start(bot, config.payment.monitorIntervalMs);

  const enabledMethods = [];
  if (config.payment.usdt.enabled) enabledMethods.push('USDT BEP-20');
  if (config.payment.binanceTransfer.enabled) enabledMethods.push('Binance Transfer');

  logger.info('PixVerifyBot is running!', {
    adminIds: config.admin.userIds,
    apiBaseUrl: config.api.baseUrl,
    creditPrice: `$${config.credits.priceUsd}`,
    paymentMethods: enabledMethods.length > 0 ? enabledMethods.join(', ') : 'none configured',
  });

  // Graceful shutdown
  const shutdown = (signal) => {
    logger.info(`Received ${signal}, shutting down...`);
    PaymentMonitor.stop();
    bot.stopPolling();
    closeDatabase();
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('uncaughtException', (err) => {
    logger.error('Uncaught exception', { error: err.message, stack: err.stack });
    shutdown('uncaughtException');
  });
  process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled rejection', { reason: String(reason) });
  });
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
