/**
 * Debug Logger - Provides comprehensive step-by-step logging when DEBUG mode is enabled
 *
 * Usage:
 *   Set DEBUG=true in environment variables to enable debug logging
 *   Each operation should log START and FINISH phases to track execution flow
 */

interface StepTimer {
  category: string;
  description: string;
  startTime: number;
}

class DebugLogger {
  private isDebugMode: boolean;
  private activeSteps: Map<string, StepTimer> = new Map();
  private stepCounter = 0;

  constructor() {
    this.isDebugMode = process.env.DEBUG === 'true' || process.env.DEBUG === '1';
  }

  /**
   * Check if debug mode is enabled
   */
  isEnabled(): boolean {
    return this.isDebugMode;
  }

  /**
   * Log the start of an operation step
   * @param category - High-level category (e.g., 'INGESTION', 'RSS_FETCH', 'PROCESSING')
   * @param description - What we're about to do
   * @param metadata - Optional additional context
   * @returns stepId for tracking this specific step
   */
  stepStart(category: string, description: string, metadata?: Record<string, any>): string {
    if (!this.isDebugMode) return '';

    const stepId = `${category}_${++this.stepCounter}`;

    this.activeSteps.set(stepId, {
      category,
      description,
      startTime: Date.now()
    });

    const metaStr = metadata && Object.keys(metadata).length > 0
      ? ` | ${JSON.stringify(metadata)}`
      : '';

    console.log(`▶ [${category}] ${description}${metaStr}`);

    return stepId;
  }

  /**
   * Log the successful completion of an operation step
   * @param stepId - The ID returned from stepStart
   * @param result - The result or outcome of the operation
   */
  stepFinish(stepId: string, result?: Record<string, any>): void {
    if (!this.isDebugMode || !stepId) return;

    const step = this.activeSteps.get(stepId);
    if (!step) {
      console.warn(`⚠ Unknown step: ${stepId}`);
      return;
    }

    const duration = Date.now() - step.startTime;
    const resultStr = result && Object.keys(result).length > 0
      ? ` | ${JSON.stringify(result)}`
      : '';

    console.log(`✓ [${step.category}] ${step.description} (${duration}ms)${resultStr}`);

    this.activeSteps.delete(stepId);
  }

  /**
   * Log an error that occurred during a step
   * @param stepId - The ID returned from stepStart (optional if step wasn't started)
   * @param category - Category of the error
   * @param description - What failed
   * @param error - The error that occurred
   */
  stepError(stepId: string | null, category: string, description: string, error: any): void {
    if (!this.isDebugMode) return;

    let step: StepTimer | undefined;
    let duration = 0;

    if (stepId) {
      step = this.activeSteps.get(stepId);
      if (step) {
        duration = Date.now() - step.startTime;
        this.activeSteps.delete(stepId);
      }
    }

    const durationStr = duration > 0 ? ` (${duration}ms)` : '';
    const errorMsg = error instanceof Error ? error.message : String(error);

    console.log(`✗ [${step?.category || category}] ${description}${durationStr} | ${errorMsg}`);

    if (error instanceof Error && error.stack && this.isDebugMode) {
      console.log(`  Stack: ${error.stack.split('\n')[1]?.trim() || error.stack}`);
    }
  }

  /**
   * Log an informational message (only in debug mode)
   * @param category - Category of the message
   * @param message - The message to log
   * @param data - Optional data to include
   */
  info(category: string, message: string, data?: Record<string, any>): void {
    if (!this.isDebugMode) return;

    const dataStr = data && Object.keys(data).length > 0
      ? ` | ${JSON.stringify(data)}`
      : '';

    console.log(`ℹ [${category}] ${message}${dataStr}`);
  }

  /**
   * Log a warning (only in debug mode)
   * @param category - Category of the warning
   * @param message - The warning message
   * @param data - Optional data to include
   */
  warn(category: string, message: string, data?: Record<string, any>): void {
    if (!this.isDebugMode) return;

    const dataStr = data && Object.keys(data).length > 0
      ? ` | ${JSON.stringify(data)}`
      : '';

    console.log(`⚠ [${category}] ${message}${dataStr}`);
  }

  /**
   * Get a summary of currently active (unfinished) steps
   * Useful for detecting steps that haven't been properly closed
   */
  getActiveSteps(): Array<{ stepId: string; category: string; description: string; duration: number }> {
    const now = Date.now();
    return Array.from(this.activeSteps.entries()).map(([stepId, step]) => ({
      stepId,
      category: step.category,
      description: step.description,
      duration: now - step.startTime
    }));
  }

  /**
   * Log all currently active steps (useful for debugging)
   */
  logActiveSteps(): void {
    if (!this.isDebugMode) return;

    const activeSteps = this.getActiveSteps();

    if (activeSteps.length === 0) {
      console.log('📋 No active steps');
      return;
    }

    console.log(`📋 Active steps (${activeSteps.length}):`);
    activeSteps.forEach(step => {
      console.log(`  ↳ [${step.category}] ${step.description} (${step.duration}ms)`);
    });
  }
}

// Export singleton instance
export const debugLogger = new DebugLogger();
