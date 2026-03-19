require('dotenv').config();

function required(key) {
  const val = process.env[key];
  if (!val) {
    console.error(`Missing required environment variable: ${key}`);
    process.exit(1);
  }
  return val;
}

function optional(key, fallback) {
  return process.env[key] || fallback;
}

function parseList(key, fallback = []) {
  const val = process.env[key];
  if (!val) return fallback;
  return val.split(',').map(s => s.trim()).filter(Boolean);
}

function parseJSON(key, fallback) {
  const val = process.env[key];
  if (!val) return fallback;
  try {
    return JSON.parse(val);
  } catch {
    console.warn(`Invalid JSON in env var ${key}, using fallback`);
    return fallback;
  }
}

const CREDIT_PRICE = parseFloat(optional('CREDIT_PRICE_USD', '2.5'));

const config = Object.freeze({
  bot: {
    token: required('TELEGRAM_BOT_TOKEN'),
  },

  api: {
    baseUrl: optional('EXTERNAL_API_BASE_URL', 'https://iqless.icu'),
    apiKey: required('EXTERNAL_API_KEY'),
    pollIntervalMs: 3000,
    pollTimeoutMs: 5 * 60 * 1000,
  },

  db: {
    path: optional('DB_PATH', './data/pixverify.db'),
  },

  admin: {
    userIds: parseList('ADMIN_USER_IDS').map(Number),
  },

  links: {
    community: optional('COMMUNITY_LINK', 'https://t.me/your_community'),
    support: optional('SUPPORT_CONTACT', '@your_support'),
  },

  credits: {
    priceUsd: CREDIT_PRICE,
    defaultBalance: parseInt(optional('DEFAULT_CREDITS', '0'), 10),
    // Override via CREDIT_PACKAGES env var (JSON) to modify plans without code changes
    packages: parseJSON('CREDIT_PACKAGES', [
      { label: 'Starter',  credits: 1,   price: '2.50'  },
      { label: 'Basic',    credits: 5,   price: '12.00' },
      { label: 'Standard', credits: 10,  price: '23.00' },
      { label: 'Pro',      credits: 20,  price: '44.00' },
      { label: 'Advanced', credits: 50,  price: '105.00' },
      { label: 'Bulk',     credits: 100, price: '200.00' },
    ]),
  },

  payment: {
    monitorIntervalMs: parseInt(optional('PAYMENT_MONITOR_INTERVAL_MS', '15000'), 10),
    orderExpiryMinutes: parseInt(optional('PAYMENT_ORDER_EXPIRY_MINUTES', '60'), 10),

    usdt: {
      walletAddress: optional('USDT_BEP20_WALLET_ADDRESS', ''),
      bscscanApiKey: optional('BSCSCAN_API_KEY', ''),
      enabled: !!process.env.USDT_BEP20_WALLET_ADDRESS,
    },

    binanceTransfer: {
      payId: optional('BINANCE_PAY_ID', ''),
      apiKey: optional('BINANCE_API_KEY', ''),
      apiSecret: optional('BINANCE_API_SECRET', ''),
      enabled: !!process.env.BINANCE_PAY_ID,
    },
  },

  rateLimit: {
    windowMs: parseInt(optional('RATE_LIMIT_WINDOW_MS', '60000'), 10),
    maxRequests: parseInt(optional('RATE_LIMIT_MAX_REQUESTS', '20'), 10),
    runMax: parseInt(optional('RATE_LIMIT_RUN_MAX', '3'), 10),
  },

  logging: {
    level: optional('LOG_LEVEL', 'info'),
    file: optional('LOG_FILE', './data/logs/bot.log'),
  },
});

module.exports = config;
