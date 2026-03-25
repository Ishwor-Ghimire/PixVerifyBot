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

    // Track generation ID outside try so catch can mark it failed
    let generationId = null;

    try {
      // 2. Create generation record (stores credentials for retrieval on success)
      generationId = Generation.create({
        telegramUserId,
        email,
        password,
        totpSecret,
        creditsUsed: isAdmin ? 0 : 1,
      });

      // 3. Submit to external API with priority
      const priority = isAdmin ? 1 : 0;
      const submission = await GoogleOneClient.submitJob(email, password, totpSecret, priority);

      if (!submission.success) {
        // Handle specific API rejection codes
        const errorCode = submission.code;

        if (errorCode === 'ALREADY_PROCESSED') {
          let existingUrl = submission.url || '';
          let processedAt = submission.created_at || '';

          if (!existingUrl) {
            const existingResult = await GoogleOneClient.getResultByEmail(email);
            if (existingResult.success && existingResult.url) {
              existingUrl = existingResult.url;
              processedAt = existingResult.created_at || processedAt;
            }
          }

          if (existingUrl) {
            Generation.updateStatus(generationId, {
              status: 'success',
              resultUrl: existingUrl,
            });

            // The upstream API returns HTTP 409 for reused results, so mirror that as no-charge locally.
            if (!isAdmin) {
              CreditService.refundCredits(telegramUserId, 1);
            }

            logger.info('Generation reused existing result', {
              generationId,
              telegramUserId,
              email,
              processedAt,
            });

            return {
              success: true,
              generationId,
              url: existingUrl,
              elapsed: 0,
              reusedResult: true,
              processedAt,
              noCharge: !isAdmin,
            };
          }
        }

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
        } catch { }
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
          try { await onProgress(status); } catch { }
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
      // Unexpected error — mark generation row as failed so user doesn't get locked out
      logger.error('Generation unexpected error', { generationId, error: err.message });

      if (generationId) {
        try {
          Generation.updateStatus(generationId, {
            status: 'failed',
            errorCode: 'INTERNAL_ERROR',
          });
        } catch (dbErr) {
          logger.error('Failed to mark generation as failed', { generationId, error: dbErr.message });
        }
      }

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
   * Reconcile stale generations on startup.
   * Marks any pending/queued/running rows as failed and refunds credits.
   * Called once at boot to recover from crashes.
   */
  reconcileStaleGenerations() {
    const stale = Generation.getStale();
    if (stale.length === 0) return;

    logger.warn(`Reconciling ${stale.length} stale generation(s) from previous run`);

    for (const gen of stale) {
      try {
        Generation.updateStatus(gen.id, {
          status: 'failed',
          errorCode: 'PROCESS_RESTART',
        });
        if (gen.credits_used > 0) {
          CreditService.refundCredits(gen.telegram_user_id, gen.credits_used);
          logger.info('Refunded stale generation', {
            generationId: gen.id,
            userId: gen.telegram_user_id,
            credits: gen.credits_used,
          });
        }
      } catch (err) {
        logger.error('Failed to reconcile generation', { id: gen.id, error: err.message });
      }
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
