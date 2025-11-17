/**
 * API endpoint for background job status and metrics
 */

import { Router } from 'express';
import { metricsTracker } from '../jobs/metrics-tracker';
import { getJobRunStats } from '../jobs/job-status';
import { getSchedulerStatus } from '../jobs/scheduler';

const router = Router();

/**
 * GET /api/job-status
 * Returns current status and metrics for the background job
 */
router.get('/', async (_req, res) => {
  try {
    // Get scheduler status
    const schedulerStatus = getSchedulerStatus();

    // Get in-memory metrics
    const memoryStats = metricsTracker.getStats();

    // Get database stats
    const dbStats = await getJobRunStats();

    // Determine health status
    const isHealthy =
      schedulerStatus.isRunning &&
      dbStats.consecutiveFailures < 3 &&
      (dbStats.lastRun?.status === 'SUCCESS' || dbStats.lastRun?.status === 'RUNNING');

    // Calculate time since last run
    let timeSinceLastRunMs: number | null = null;
    if (dbStats.lastRun?.startedAt) {
      timeSinceLastRunMs = Date.now() - new Date(dbStats.lastRun.startedAt).getTime();
    }

    res.json({
      healthy: isHealthy,
      scheduler: {
        running: schedulerStatus.isRunning,
        cronExpression: schedulerStatus.cronExpression,
        description: 'Runs every 1 minute',
        currentlyExecuting: schedulerStatus.isJobCurrentlyExecuting,
      },
      stats: {
        totalRuns: dbStats.totalRuns,
        successfulRuns: dbStats.successfulRuns,
        failedRuns: dbStats.failedRuns,
        consecutiveFailures: dbStats.consecutiveFailures,
        averageDurationMs: dbStats.averageDurationMs,
      },
      lastRun: dbStats.lastRun
        ? {
            id: dbStats.lastRun.id,
            startedAt: dbStats.lastRun.startedAt,
            completedAt: dbStats.lastRun.completedAt,
            status: dbStats.lastRun.status,
            articlesProcessed: dbStats.lastRun.articlesProcessed,
            embeddingsCreated: dbStats.lastRun.embeddingsCreated,
            durationMs: dbStats.lastRun.durationMs,
            errorMessage: dbStats.lastRun.errorMessage,
            timeSinceLastRunMs,
          }
        : null,
      recentRuns: dbStats.recentRuns.map((run) => ({
        id: run.id,
        startedAt: run.startedAt,
        completedAt: run.completedAt,
        status: run.status,
        articlesProcessed: run.articlesProcessed,
        embeddingsCreated: run.embeddingsCreated,
        durationMs: run.durationMs,
        errorMessage: run.errorMessage,
      })),
      memory: {
        totalArticlesProcessed: memoryStats.totalArticlesProcessed,
        totalEmbeddingsCreated: memoryStats.totalEmbeddingsCreated,
        lastSuccessAt: memoryStats.lastSuccessAt,
        lastError: memoryStats.lastError,
      },
    });
  } catch (error) {
    console.error('Error fetching job status:', error);
    res.status(500).json({
      error: 'Failed to fetch job status',
      message: error instanceof Error ? error.message : String(error),
    });
  }
});

export default router;
