const Generation = require('../db/models/Generation');
const CreditService = require('./creditService');
const GoogleOneClient = require('../api/googleOneClient');
const logger = require('../utils/logger');

const GenerationService = {
  /**
   * Full generation lifecycle:
   * 1. Check balance & reserve credit
   * 2. Create DB record
   * 3. Submit to external API
   * 4. Poll until done
   * 5. Update record + handle refund on failure
   *
   * Returns { success, generationId, url?, error?, elapsed? }
   */
  async startGeneration(telegramUserId, email, password, totpSecret, onProgress = null) {
    // 1. Reserve credit
    const reserved = CreditService.reserveCredits(telegramUserId, 1);
    if (!reserved) {
      return { success: false, error: 'INSUFFICIENT_CREDITS' };
    }

    try {
      // 2. Create generation record
      const generationId = Generation.create({
        telegramUserId,
        email,
        creditsUsed: 1,
      });

      // 3. Submit to external API
      const submission = await GoogleOneClient.submitJob(email, password, totpSecret);

      if (!submission.success) {
        // API rejected the submission — refund credits
        Generation.updateStatus(generationId, {
          status: 'failed',
          errorCode: submission.code,
        });
        CreditService.refundCredits(telegramUserId, 1);
        return {
          success: false,
          generationId,
          error: submission.code,
          message: submission.message,
        };
      }

      // Update record with job_id
      Generation.updateStatus(generationId, {
        status: 'queued',
        jobId: submission.job_id,
      });

      // 4. Poll for result
      const result = await GoogleOneClient.pollJob(submission.job_id, (status) => {
        // Update generation status as it progresses
        if (status.status === 'running') {
          Generation.updateStatus(generationId, {
            status: 'running',
            jobId: submission.job_id,
          });
        }
        if (onProgress) onProgress(status);
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
        // Refund on failure (external API doesn't charge for failures)
        CreditService.refundCredits(telegramUserId, 1);
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
      CreditService.refundCredits(telegramUserId, 1);
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
