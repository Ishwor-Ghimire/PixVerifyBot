const axios = require('axios');
const config = require('../config');
const logger = require('../utils/logger');

const client = axios.create({
  baseURL: config.api.baseUrl,
  timeout: 15000,
  headers: {
    'Content-Type': 'application/json',
    'X-API-Key': config.api.apiKey,
  },
});

// Map API error responses to structured errors
function parseApiError(error) {
  if (!error.response) {
    return { code: 'NETWORK_ERROR', message: 'Cannot reach the generation API', status: 0 };
  }
  const { status, data } = error.response;
  const detail = data?.detail || {};
  return {
    code: (detail.code || `HTTP_${status}`).toUpperCase(),
    message: detail.message || error.message,
    status,
  };
}

const GoogleOneClient = {
  /**
   * Health check — no auth required
   */
  async checkHealth() {
    try {
      const { data } = await client.get('/api/health');
      return { ok: true, ...data };
    } catch (err) {
      logger.error('Health check failed', { error: err.message });
      return { ok: false, error: err.message };
    }
  },

  /**
   * Submit a new generation job
   */
  async submitJob(email, password, totpSecret) {
    try {
      const { data } = await client.post('/api/jobs', {
        email,
        password,
        totp_secret: totpSecret,
      });
      logger.info('Job submitted', { jobId: data.job_id, email });
      return { success: true, ...data };
    } catch (err) {
      const apiErr = parseApiError(err);
      logger.warn('Job submission failed', { email, ...apiErr });
      return { success: false, ...apiErr };
    }
  },

  /**
   * Get job status
   */
  async getJobStatus(jobId) {
    const { data } = await client.get(`/api/jobs/${jobId}`);
    return data;
  },

  /**
   * Poll job until terminal state (success/failed) or timeout.
   * Invokes onProgress callback with each poll result.
   */
  async pollJob(jobId, onProgress = null) {
    const startTime = Date.now();
    const { pollIntervalMs, pollTimeoutMs } = config.api;

    const isTimedOut = () => Date.now() - startTime >= pollTimeoutMs;

    while (!isTimedOut()) {
      try {
        const status = await this.getJobStatus(jobId);

        if (onProgress) {
          try { await onProgress(status); } catch {}  // await the async callback
        }

        if (status.status === 'success') {
          return { success: true, url: status.url, elapsed: status.elapsed_seconds };
        }
        if (status.status === 'failed') {
          return { success: false, error: status.error, elapsed: status.elapsed_seconds };
        }
      } catch (err) {
        // Terminal HTTP errors (401 invalid key, 404 job not found) should not be retried
        if (err.response && [401, 404].includes(err.response.status)) {
          const apiErr = parseApiError(err);
          return { success: false, error: apiErr.code, elapsed: (Date.now() - startTime) / 1000 };
        }
        logger.warn('Poll error, retrying', { jobId, error: err.message });
      }

      // Hard guard: re-check timeout after potentially slow operations above
      if (isTimedOut()) break;

      await new Promise(r => setTimeout(r, pollIntervalMs));
    }

    return { success: false, error: 'TIMEOUT', elapsed: (Date.now() - startTime) / 1000 };
  },

  /**
   * Get queue status
   */
  async getQueue() {
    try {
      const { data } = await client.get('/api/queue');
      return { ok: true, ...data };
    } catch (err) {
      logger.error('Queue check failed', { error: err.message });
      return { ok: false, error: err.message };
    }
  },

  /**
   * Get API key balance
   */
  async getApiBalance() {
    try {
      const { data } = await client.get('/api/balance');
      return data;
    } catch (err) {
      logger.error('Balance check failed', { error: err.message });
      return null;
    }
  },
};

module.exports = GoogleOneClient;
