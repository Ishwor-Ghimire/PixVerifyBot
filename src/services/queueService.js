const GoogleOneClient = require('../api/googleOneClient');
const { formatDuration } = require('../utils/helpers');

const QueueService = {
  /**
   * Get formatted queue status from external API
   */
  async getStatus() {
    const queue = await GoogleOneClient.getQueue();

    if (!queue.ok) {
      return { ok: false, error: queue.error };
    }

    const activeJobs = (queue.current_job_ids || []).filter(Boolean).length;

    return {
      ok: true,
      activeJobs,
      pendingJobs: queue.pending_count || 0,
      devicesTotal: queue.device_count || 0,
      devicesReady: queue.devices_ready || 0,
      devicesConnected: queue.devices_connected || 0,
      estimatedTimePerJob: queue.est_seconds_per_job || 55,
      estimatedWait: queue.pending_count > 0
        ? formatDuration((queue.pending_count * (queue.est_seconds_per_job || 55)) / Math.max(queue.devices_ready || 1, 1))
        : 'No wait',
    };
  },
};

module.exports = QueueService;
