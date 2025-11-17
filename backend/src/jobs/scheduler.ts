/**
 * Background job scheduler using node-cron
 */

import * as cron from 'node-cron';
import { runNewsIngestionJob, isIngestionJobRunning } from './news-ingestion-job';

// Cron expression: runs every 1 minute
const CRON_EXPRESSION = '*/1 * * * *';

let scheduledTask: cron.ScheduledTask | null = null;

/**
 * Start the background job scheduler
 */
export function startJobScheduler(): void {
  if (scheduledTask) {
    console.warn('Job scheduler is already running');
    return;
  }

  // Validate cron expression
  if (!cron.validate(CRON_EXPRESSION)) {
    throw new Error(`Invalid cron expression: ${CRON_EXPRESSION}`);
  }

  // Schedule the job
  scheduledTask = cron.schedule(CRON_EXPRESSION, async () => {
    await runNewsIngestionJob();
  });

  console.log('🤖 Background job scheduler started (runs every 1 minute)');

  // Run immediately on startup (don't wait for first cron tick)
  runNewsIngestionJob().catch((error) => {
    console.error('Error in initial job run:', error);
  });
}

/**
 * Stop the background job scheduler
 */
export function stopJobScheduler(): void {
  if (!scheduledTask) {
    console.warn('Job scheduler is not running');
    return;
  }

  scheduledTask.stop();
  scheduledTask = null;

  console.log('Background job scheduler stopped');
}

/**
 * Gracefully shutdown: stop scheduler and wait for current job to finish
 */
export async function gracefulShutdown(): Promise<void> {
  console.log('Stopping background job scheduler...');

  // Stop accepting new job executions
  stopJobScheduler();

  // Wait for current job to finish (with timeout)
  const maxWaitTime = 30000; // 30 seconds
  const startWait = Date.now();

  while (isIngestionJobRunning() && Date.now() - startWait < maxWaitTime) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  if (isIngestionJobRunning()) {
    console.warn('Background job did not finish within timeout period');
  } else {
    console.log('Background job scheduler shut down gracefully');
  }
}

/**
 * Get scheduler status
 */
export function getSchedulerStatus(): {
  isRunning: boolean;
  cronExpression: string;
  isJobCurrentlyExecuting: boolean;
} {
  return {
    isRunning: scheduledTask !== null,
    cronExpression: CRON_EXPRESSION,
    isJobCurrentlyExecuting: isIngestionJobRunning(),
  };
}
