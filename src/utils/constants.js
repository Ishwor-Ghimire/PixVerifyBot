// Bot message templates
const MESSAGES = {
  WELCOME: [
    '👋 Welcome to *PixVerifyBot*!',
    '',
    'This bot helps you verify your Google Pixel device in your Google Account, allowing you to claim a free 1-year Google AI.',
    '',
    'Before verification make sure you have your Google Mail (Gmail) address, Password and TOTP secret key ready.',
    '',
    'Use /help if you cannot find TOTP secret key or contact @PixVerify',
    '',
    'Use /menu to see available actions.',
  ].join('\n'),

  HELP: [
    '📖 *How to use PixVerifyBot*',
    '',
    '1️⃣ Check your balance with /balance',
    '2️⃣ Buy credits with /buy if needed',
    '3️⃣ Run /run to start verification',
    '4️⃣ Provide your Google account details when prompted',
    '5️⃣ Wait for the link to be generated',
    '',
    '📸 *Where to find TOTP?*',
    '• For photo-by-photo instructions on how to get your TOTP key, visit: https://pixverify.netlify.app',
    '',
    '*Commands:*',
    '• /run — Start verification',
    '• /balance — Check your credits',
    '• /buy — Purchase credits',
    '• /myhistory — View past generations',
    '• /queue — Check queue status',
    '• /community — Join our community',
    '• /support — Get help',
    '• /menu — Main menu',
  ].join('\n'),

  INSUFFICIENT_CREDITS: '⚠️ Insufficient credits. Use /buy to purchase more.',

  RUN_START: '🚀 *Start Verification*\n\nProvide your Google Mail (Gmail) address:',
  RUN_ASK_PASSWORD: '🔑 Provide your Google Mail Password:',
  RUN_ASK_TOTP: '🔐 Provide your TOTP secret key. (Need /help?)',
  RUN_CONFIRM: '📋 *Please confirm your submission:*',
  RUN_SUBMITTED: '⏳ Job submitted! Tracking your request...',
  RUN_SUCCESS: '✅ *Link generated successfully!*',
  RUN_FAILED: '❌ *Generation failed*',
  RUN_CANCELLED: '🚫 Generation cancelled.',

  INVALID_EMAIL: '⚠️ Invalid email format. Please try again:',
  INVALID_TOTP: '⚠️ Invalid TOTP secret. Must be Base32 encoded (letters A-Z, digits 2-7). Try again:',

  BALANCE_TEMPLATE: '💰 *Your Balance*\n\nCredits: *{balance}*',

  HISTORY_EMPTY: '📭 No generation history yet. Use /run to get started!',
  HISTORY_HEADER: '📋 *Your Generation History*\n',

  QUEUE_HEADER: '📊 *Queue Status*\n',

  HEALTH_HEADER: '🏥 *System Health*\n',

  COMMUNITY: '🌐 *Join our community:*\n\n{link}',
  SUPPORT: '🛟 *Need help?*\n\nContact support: {contact}',

  MENU_HEADER: '📱 *Main Menu*\n\nChoose an action:',

  BUY_HEADER: '🛒 *Purchase Credits*\n\nSelect a package:',

  ADMIN_ONLY: '🔒 This command is restricted to administrators.',
  RATE_LIMITED: '⏱️ Slow down! Please wait before trying again.',
  ERROR_GENERIC: '⚠️ Something went wrong. Please try again later.',
  ALREADY_RUNNING: '⏳ You already have a generation in progress. Please wait for it to complete.',
};

// Generation status labels
const STATUS_LABELS = {
  pending: '🟡 Pending',
  queued: '🟠 Queued',
  running: '🔵 Processing',
  success: '🟢 Success',
  failed: '🔴 Failed',
};

// Callback data prefixes
const CALLBACKS = {
  CONFIRM_RUN: 'confirm_run',
  CANCEL_RUN: 'cancel_run',
  BUY_PACKAGE: 'buy_pkg_',
  PAY_METHOD: 'pay_m_',
  PAY_CANCEL: 'pay_cancel',
  HISTORY_PAGE: 'history_page_',
  MENU_ACTION: 'menu_',
  ADMIN_CONFIRM: 'adm_cfm_',
  ADMIN_REJECT: 'adm_rej_',
  BINANCE_PAID: 'bnc_paid_',

  // Admin Panel Callbacks
  ADMIN_MENU: 'adm_menu',
  ADMIN_STATS: 'adm_stats',
  ADMIN_USER_SEARCH: 'adm_usr_search',
  ADMIN_SETTINGS: 'adm_settings',
};

module.exports = { MESSAGES, STATUS_LABELS, CALLBACKS };
