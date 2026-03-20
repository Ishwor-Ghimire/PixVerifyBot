const Generation = require('../db/models/Generation');
const CreditService = require('./creditService');
const GoogleOneClient = require('../api/googleOneClient');
const logger = require('../utils/logger');

const GenerationService = {
  /**
   * Full generation lifecycle (ported from Api_Pixel_Bot):
   * 1. Check balance & reserve credit
   * 2. Create DB record
   * 3. Submit to external API (with priority support)
   * 4. Poll until done (setInterval-based with background fallback)
   * 5. Update record + handle refund on failure
   *
   * Returns { success, generationId, url?, error?, elapsed? }
   */
  async startGeneration(telegramUserId, email, password, totpSecret, onProgress = null, isAdmin = false) {
    // 1. Reserve credit (skip for admin)
    if (!isAdmin) {
      const reserved = CreditService.reserveCredits(telegramUserId, 1);
      if (!reserved) {
        return { success: false, error: 'INSUFFICIENT_CREDITS' };
      }
    }

    try {
      // 2. Create generation record
      const generationId = Generation.create({
        telegramUserId,
        email,
        creditsUsed: isAdmin ? 0 : 1,
      });

      // 3. Submit to external API with priority
      const priority = isAdmin ? 1 : 0;
      const submission = await GoogleOneClient.submitJob(email, password, totpSecret, priority);

      if (!submission.success) {
        // Handle specific API rejection codes
        const errorCode = submission.code;

        Generation.updateStatus(generationId, {
          status: 'failed',
          errorCode,
        });

        // Refund credits on submission failure
        if (!isAdmin) {
          CreditService.refundCredits(telegramUserId, 1);
        }

        return {
          success: false,
          generationId,
          error: errorCode,
          message: submission.message,
          // Pass HTTP status for special handling (409 already_queued, 402 balance)
          httpStatus: submission.status,
        };
      }

      // Update record with job_id
      Generation.updateStatus(generationId, {
        status: 'queued',
        jobId: submission.job_id,
      });

      // Notify caller with initial queue info
      if (onProgress) {
        try {
          await onProgress({
            status: 'queued',
            queue_position: submission.queue_position ?? -1,
            estimated_wait_seconds: submission.estimated_wait_seconds ?? 0,
            stage: 0,
            total_stages: 8,
            stage_label: '',
            isBackground: false,
          });
        } catch {}
      }

      // 4. Poll for result (setInterval-based with background fallback)
      const result = await GoogleOneClient.pollJob(submission.job_id, async (status) => {
        // Update generation status as it progresses
        if (status.status === 'running') {
          Generation.updateStatus(generationId, {
            status: 'running',
            jobId: submission.job_id,
          });
        }
        // Forward all progress to caller (queue pos, stage, progress bar data)
        if (onProgress) {
          try { await onProgress(status); } catch {}
        }
      });

      // 5. Handle result
      if (result.success) {
        Generation.updateStatus(generationId, {
          status: 'success',
          jobId: submission.job_id,
          resultUrl: result.url,
        });
        logger.info('Generation succeeded', { generationId, telegramUserId, email });
        return {
          success: true,
          generationId,
          url: result.url,
          elapsed: result.elapsed,
        };
      } else {
        Generation.updateStatus(generationId, {
          status: 'failed',
          jobId: submission.job_id,
          errorCode: result.error,
        });
        // Refund on failure
        if (!isAdmin) {
          CreditService.refundCredits(telegramUserId, 1);
        }
        logger.warn('Generation failed', { generationId, error: result.error });
        return {
          success: false,
          generationId,
          error: result.error,
          elapsed: result.elapsed,
        };
      }
    } catch (err) {
      // Unexpected error — refund and mark failed
      logger.error('Generation unexpected error', { error: err.message });
      if (!isAdmin) {
        CreditService.refundCredits(telegramUserId, 1);
      }
      return {
        success: false,
        error: 'INTERNAL_ERROR',
        message: err.message,
      };
    }
  },

  /**
   * Get paginated history for a user
   */
  getHistory(telegramUserId, page = 1, perPage = 5) {
    const offset = (page - 1) * perPage;
    const records = Generation.getByUser(telegramUserId, perPage, offset);
    const total = Generation.getCount(telegramUserId);
    return {
      records,
      total,
      page,
      totalPages: Math.ceil(total / perPage),
    };
  },

  /**
   * Check if user has an active generation in progress
   */
  hasActiveGeneration(telegramUserId) {
    return Generation.hasActive(telegramUserId);
  },
};

module.exports = GenerationService;
