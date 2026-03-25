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
  const detail = data?.detail;
  const detailObject = detail && typeof detail === 'object' ? detail : {};
  const code = data?.code || (typeof detail === 'string' ? detail : detailObject.code);
  const message = data?.message || (typeof detail === 'string' ? detail : detailObject.message);
  return {
    code: (code || `HTTP_${status}`).toUpperCase(),
    message: message || error.message,
    status,
    url: data?.url || detailObject.url || null,
    created_at: data?.created_at || detailObject.created_at || null,
    email: data?.email || detailObject.email || null,
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
   * @param {string} email
   * @param {string} password
   * @param {string} totpSecret
   * @param {number} priority - 0 = normal, 1 = VIP/admin
   */
  async submitJob(email, password, totpSecret, priority = 0) {
    try {
      const { data } = await client.post('/api/jobs', {
        email,
        password,
        totp_secret: totpSecret,
        priority,
      });
      logger.info('Job submitted', { jobId: data.job_id, email });
      return {
        success: true,
        job_id: data.job_id,
        queue_position: data.queue_position,
        estimated_wait_seconds: data.estimated_wait_seconds,
        device: data.device,
      };
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
   * Look up an existing result by email
   */
  async getResultByEmail(email) {
    try {
      const { data } = await client.get('/api/result', {
        params: { email },
      });
      return { success: true, ...data };
    } catch (err) {
      const apiErr = parseApiError(err);
      logger.warn('Result lookup failed', { email, ...apiErr });
      return { success: false, ...apiErr };
    }
  },

  /**
   * Poll job with setInterval-based approach (matching Api_Pixel_Bot).
   * - Active polling: 3s intervals for up to 5min
   * - Background fallback: switches to 30s intervals after 5min
   * - Invokes onProgress with each poll result
   *
   * Returns a Promise that resolves when the job reaches a terminal state.
   */
  pollJob(jobId, onProgress = null) {
    const ACTIVE_POLL_MS = config.api.pollIntervalMs || 3000;
    const BG_POLL_MS = 30000;
    const MAX_ACTIVE_MS = config.api.pollTimeoutMs || 300000; // 5 minutes

    return new Promise((resolve) => {
      let elapsed = 0;
      let currentInterval = ACTIVE_POLL_MS;
      let isBackground = false;
      let intervalHandle = null;

      const cleanup = () => {
        if (intervalHandle) {
          clearInterval(intervalHandle);
          intervalHandle = null;
        }
      };

      const doPoll = async () => {
        elapsed += currentInterval;

        try {
          const job = await this.getJobStatus(jobId);
          const status = job.status?.toLowerCase();

          // Forward progress to caller
          if (onProgress) {
            try {
              await onProgress({
                status,
                stage: job.stage ?? 0,
                total_stages: job.total_stages ?? 8,
                stage_label: job.stage_label || '',
                queue_position: job.queue_position ?? -1,
                estimated_wait_seconds: job.estimated_wait_seconds ?? 0,
                isBackground,
              });
            } catch {} // Don't crash on callback errors
          }

          // Still in progress
          if (status === 'queued' || status === 'running') {
            // Switch to background polling after max active time
            if (!isBackground && elapsed >= MAX_ACTIVE_MS) {
              isBackground = true;
              currentInterval = BG_POLL_MS;
              cleanup();

              // Notify caller about background switch
              if (onProgress) {
                try {
                  await onProgress({ status: 'background', isBackground: true });
                } catch {}
              }

              // Restart with slower interval
              intervalHandle = setInterval(doPoll, BG_POLL_MS);
            }
            return; // Keep polling
          }

          // Terminal state
          cleanup();

          if (status === 'success') {
            resolve({
              success: true,
              url: job.url || '',
              elapsed: job.elapsed_seconds,
            });
          } else {
            // Failed or unknown terminal status
            resolve({
              success: false,
              error: job.error || 'UNKNOWN_ERROR',
              elapsed: job.elapsed_seconds,
            });
          }
        } catch (err) {
          // Terminal HTTP errors should stop polling
          if (err.response && [401, 404].includes(err.response.status)) {
            cleanup();
            const apiErr = parseApiError(err);
            resolve({
              success: false,
              error: apiErr.code,
              elapsed: elapsed / 1000,
            });
            return;
          }
          // Network errors — keep trying
          logger.warn('Poll error, retrying', { jobId, error: err.message });
        }
      };

      // Start polling
      intervalHandle = setInterval(doPoll, currentInterval);

      // Also do an immediate first poll
      doPoll();
    });
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
