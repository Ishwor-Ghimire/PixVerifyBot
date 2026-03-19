/**
 * Validate email format (basic check)
 */
function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 320;
}

/**
 * Validate Base32 TOTP secret
 */
function isValidTotpSecret(secret) {
  return /^[A-Z2-7]+=*$/i.test(secret) && secret.length >= 1 && secret.length <= 64;
}

/**
 * Truncate text to max length with ellipsis
 */
function truncate(text, maxLen = 40) {
  if (!text || text.length <= maxLen) return text || '';
  return text.slice(0, maxLen - 1) + '…';
}

/**
 * Format Unix timestamp to readable date string
 */
function formatDate(timestamp) {
  if (!timestamp) return 'N/A';
  const date = typeof timestamp === 'number'
    ? new Date(timestamp * 1000)
    : new Date(timestamp);
  return date.toLocaleString('en-US', {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

/**
 * Mask sensitive string (show first 3 and last 3 chars)
 */
function maskString(str) {
  if (!str || str.length < 8) return '••••••';
  return str.slice(0, 3) + '•'.repeat(Math.min(str.length - 6, 8)) + str.slice(-3);
}

/**
 * Escape Telegram MarkdownV2 special characters
 */
function escapeMarkdown(text) {
  if (!text) return '';
  return text.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, '\\$&');
}

/**
 * Format seconds to human-readable duration
 */
function formatDuration(seconds) {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const mins = Math.floor(seconds / 60);
  const secs = Math.round(seconds % 60);
  return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`;
}

module.exports = {
  isValidEmail,
  isValidTotpSecret,
  truncate,
  formatDate,
  maskString,
  escapeMarkdown,
  formatDuration,
};
