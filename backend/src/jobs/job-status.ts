/**
 * Manages job execution status and persistence
 */

import { prisma } from '../utils/db';
import { JobMetrics } from './metrics-tracker';

export type JobStatus = 'RUNNING' | 'SUCCESS' | 'FAILED';

/**
 * Create a new job run record in the database
 */
export async function createJobRun(): Promise<string> {
  const jobRun = await prisma.jobRun.create({
    data: {
      startedAt: new Date(),
      status: 'RUNNING',
    },
  });
  return jobRun.id;
}

/**
 * Update job run with success status
 */
export async function completeJobRun(
  jobRunId: string,
  metrics: JobMetrics
): Promise<void> {
  await prisma.jobRun.update({
    where: { id: jobRunId },
    data: {
      completedAt: new Date(),
      status: 'SUCCESS',
      articlesProcessed: metrics.articlesProcessed,
      embeddingsCreated: metrics.embeddingsCreated,
      durationMs: metrics.durationMs,
    },
  });
}

/**
 * Update job run with failure status
 */
export async function failJobRun(jobRunId: string, error: string): Promise<void> {
  await prisma.jobRun.update({
    where: { id: jobRunId },
    data: {
      completedAt: new Date(),
      status: 'FAILED',
      errorMessage: error,
    },
  });
}

/**
 * Get the most recent job run
 */
export async function getLastJobRun() {
  return await prisma.jobRun.findFirst({
    orderBy: { startedAt: 'desc' },
  });
}

/**
 * Get job run statistics
 */
export async function getJobRunStats() {
  const [totalRuns, successfulRuns, failedRuns, lastRun, recentRuns] = await Promise.all([
    prisma.jobRun.count(),
    prisma.jobRun.count({ where: { status: 'SUCCESS' } }),
    prisma.jobRun.count({ where: { status: 'FAILED' } }),
    prisma.jobRun.findFirst({
      orderBy: { startedAt: 'desc' },
    }),
    prisma.jobRun.findMany({
      orderBy: { startedAt: 'desc' },
      take: 10,
      select: {
        id: true,
        startedAt: true,
        completedAt: true,
        status: true,
        articlesProcessed: true,
        embeddingsCreated: true,
        durationMs: true,
        errorMessage: true,
      },
    }),
  ]);

  // Calculate consecutive failures
  let consecutiveFailures = 0;
  for (const run of recentRuns) {
    if (run.status === 'FAILED') {
      consecutiveFailures++;
    } else if (run.status === 'SUCCESS') {
      break;
    }
  }

  // Calculate average duration for successful runs
  const successfulRunsWithDuration = recentRuns.filter(
    (run) => run.status === 'SUCCESS' && run.durationMs !== null
  );
  const avgDuration =
    successfulRunsWithDuration.length > 0
      ? successfulRunsWithDuration.reduce((sum, run) => sum + (run.durationMs || 0), 0) /
        successfulRunsWithDuration.length
      : 0;

  return {
    totalRuns,
    successfulRuns,
    failedRuns,
    lastRun,
    recentRuns,
    consecutiveFailures,
    averageDurationMs: Math.round(avgDuration),
  };
}
