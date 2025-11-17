/**
 * Tracks metrics for background job execution
 */

export interface JobMetrics {
  articlesProcessed: number;
  embeddingsCreated: number;
  durationMs: number;
  error?: string;
}

export interface JobStats {
  totalRuns: number;
  successfulRuns: number;
  failedRuns: number;
  lastRunAt: Date | null;
  lastSuccessAt: Date | null;
  lastError: string | null;
  consecutiveFailures: number;
  averageDurationMs: number;
  totalArticlesProcessed: number;
  totalEmbeddingsCreated: number;
}

class MetricsTracker {
  private stats: JobStats = {
    totalRuns: 0,
    successfulRuns: 0,
    failedRuns: 0,
    lastRunAt: null,
    lastSuccessAt: null,
    lastError: null,
    consecutiveFailures: 0,
    averageDurationMs: 0,
    totalArticlesProcessed: 0,
    totalEmbeddingsCreated: 0,
  };

  /**
   * Record the start of a job run
   */
  recordJobStart(): void {
    this.stats.lastRunAt = new Date();
    this.stats.totalRuns++;
  }

  /**
   * Record a successful job completion
   */
  recordJobSuccess(metrics: JobMetrics): void {
    this.stats.successfulRuns++;
    this.stats.consecutiveFailures = 0;
    this.stats.lastSuccessAt = new Date();
    this.stats.lastError = null;

    // Update aggregated metrics
    this.stats.totalArticlesProcessed += metrics.articlesProcessed;
    this.stats.totalEmbeddingsCreated += metrics.embeddingsCreated;

    // Update average duration
    const totalDuration = this.stats.averageDurationMs * (this.stats.successfulRuns - 1);
    this.stats.averageDurationMs = (totalDuration + metrics.durationMs) / this.stats.successfulRuns;
  }

  /**
   * Record a failed job run
   */
  recordJobFailure(error: string): void {
    this.stats.failedRuns++;
    this.stats.consecutiveFailures++;
    this.stats.lastError = error;
  }

  /**
   * Get current stats
   */
  getStats(): JobStats {
    return { ...this.stats };
  }

  /**
   * Check if job is in a critical failure state (3+ consecutive failures)
   */
  isCriticalFailureState(): boolean {
    return this.stats.consecutiveFailures >= 3;
  }

  /**
   * Get consecutive failure count
   */
  getConsecutiveFailures(): number {
    return this.stats.consecutiveFailures;
  }
}

// Singleton instance
export const metricsTracker = new MetricsTracker();
