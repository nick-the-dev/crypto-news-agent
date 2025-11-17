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
    const timestamp = new Date().toISOString();

    this.activeSteps.set(stepId, {
      category,
      description,
      startTime: Date.now()
    });

    console.log('\n' + '='.repeat(80));
    console.log(`[DEBUG] ${timestamp}`);
    console.log(`[${category}] STARTED: ${description}`);

    if (metadata && Object.keys(metadata).length > 0) {
      console.log('Context:', JSON.stringify(metadata, null, 2));
    }

    console.log('='.repeat(80));

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
      console.warn(`[DEBUG] Warning: Attempted to finish unknown step: ${stepId}`);
      return;
    }

    const duration = Date.now() - step.startTime;
    const timestamp = new Date().toISOString();

    console.log('\n' + '-'.repeat(80));
    console.log(`[DEBUG] ${timestamp}`);
    console.log(`[${step.category}] FINISHED: ${step.description}`);
    console.log(`Duration: ${duration}ms`);

    if (result && Object.keys(result).length > 0) {
      console.log('Result:', JSON.stringify(result, null, 2));
    }

    console.log('-'.repeat(80) + '\n');

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

    const timestamp = new Date().toISOString();

    console.log('\n' + '!'.repeat(80));
    console.log(`[DEBUG] ${timestamp}`);
    console.log(`[${step?.category || category}] ERROR: ${description}`);

    if (duration > 0) {
      console.log(`Duration before error: ${duration}ms`);
    }

    console.log('Error details:', error instanceof Error ? error.message : String(error));

    if (error instanceof Error && error.stack) {
      console.log('Stack trace:', error.stack);
    }

    console.log('!'.repeat(80) + '\n');
  }

  /**
   * Log an informational message (only in debug mode)
   * @param category - Category of the message
   * @param message - The message to log
   * @param data - Optional data to include
   */
  info(category: string, message: string, data?: Record<string, any>): void {
    if (!this.isDebugMode) return;

    const timestamp = new Date().toISOString();

    console.log(`[DEBUG] ${timestamp} [${category}] INFO: ${message}`);

    if (data && Object.keys(data).length > 0) {
      console.log('Data:', JSON.stringify(data, null, 2));
    }
  }

  /**
   * Log a warning (only in debug mode)
   * @param category - Category of the warning
   * @param message - The warning message
   * @param data - Optional data to include
   */
  warn(category: string, message: string, data?: Record<string, any>): void {
    if (!this.isDebugMode) return;

    const timestamp = new Date().toISOString();

    console.log(`[DEBUG] ${timestamp} [${category}] WARNING: ${message}`);

    if (data && Object.keys(data).length > 0) {
      console.log('Data:', JSON.stringify(data, null, 2));
    }
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
      console.log('[DEBUG] No active steps');
      return;
    }

    console.log('\n' + '~'.repeat(80));
    console.log('[DEBUG] ACTIVE STEPS (not yet finished):');
    activeSteps.forEach(step => {
      console.log(`  - [${step.category}] ${step.description} (running for ${step.duration}ms)`);
    });
    console.log('~'.repeat(80) + '\n');
  }
}

// Export singleton instance
export const debugLogger = new DebugLogger();
