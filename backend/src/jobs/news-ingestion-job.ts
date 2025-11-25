/**
 * Background job for ingesting crypto news
 */

import { ingestionQueue } from '../ingestion';
import { metricsTracker, JobMetrics } from './metrics-tracker';
import { createJobRun, completeJobRun, failJobRun } from './job-status';
import { debugLogger } from '../utils/debug-logger';
import { prisma } from '../utils/db';

let isJobRunning = false;

/**
 * Run the news ingestion job
 */
export async function runNewsIngestionJob(): Promise<void> {
  // Prevent overlapping job executions
  if (isJobRunning) {
    debugLogger.info('JOB', 'Job already running, skipping this execution');
    return;
  }

  isJobRunning = true;
  const startTime = Date.now();
  let jobRunId: string | null = null;

  try {
    // Record job start
    metricsTracker.recordJobStart();
    jobRunId = await createJobRun();

    // Temporarily disable debug logging for routine background job execution
    const originalDebugMode = process.env.DEBUG;
    if (originalDebugMode) {
      process.env.DEBUG = 'false';
    }

    // Run ingestion pipeline
    const ingestStats = await ingestionQueue.ingest();

    // Restore debug mode
    if (originalDebugMode) {
      process.env.DEBUG = originalDebugMode;
    }

    // Count embeddings created in this run (from database)
    const embeddingsCreated = await prisma.articleEmbedding.count({
      where: {
        chunk: {
          article: {
            createdAt: {
              gte: new Date(startTime)
            }
          }
        }
      }
    });

    // Calculate metrics
    const durationMs = Date.now() - startTime;
    const metrics: JobMetrics = {
      articlesProcessed: ingestStats.new,
      embeddingsCreated: embeddingsCreated,
      durationMs,
    };

    // Record success
    metricsTracker.recordJobSuccess(metrics);
    if (jobRunId) {
      await completeJobRun(jobRunId, metrics);
    }

    // Only log when new articles are processed or if it's been a while
    if (metrics.articlesProcessed > 0) {
      console.log(
        `🎉 Background job: Processed ${metrics.articlesProcessed} new articles, ` +
        `${metrics.embeddingsCreated} embeddings (${durationMs}ms)`
      );
    } else if (debugLogger.isEnabled()) {
      // In debug mode, show summary even for 0 articles
      console.log(
        `😴 Background job: No new articles (checked ${ingestStats.fetched} articles in ${durationMs}ms)`
      );
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const durationMs = Date.now() - startTime;

    // Record failure
    metricsTracker.recordJobFailure(errorMessage);
    if (jobRunId) {
      await failJobRun(jobRunId, errorMessage);
    }

    console.error(`❌ Background job failed: ${errorMessage} (${durationMs}ms)`);

    // Log critical failure state
    if (metricsTracker.isCriticalFailureState()) {
      const failures = metricsTracker.getConsecutiveFailures();
      console.error(
        `🚨 CRITICAL: Background job has failed ${failures} times consecutively!`
      );
    }
  } finally {
    isJobRunning = false;
  }
}

/**
 * Check if a job is currently running
 */
export function isIngestionJobRunning(): boolean {
  return isJobRunning;
}
