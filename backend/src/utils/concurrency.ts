import { debugLogger } from './debug-logger';

export interface ConcurrencyOptions {
  /** Maximum number of concurrent operations. Default: 25 */
  concurrency?: number;
  /** Label for logging purposes */
  label?: string;
}

export interface ConcurrencyResult<T> {
  successful: T[];
  failed: Array<{ error: Error; index: number }>;
}

/**
 * Process items concurrently with a controlled concurrency limit.
 * Executes multiple async operations in parallel while respecting the concurrency limit.
 *
 * @param items - Array of items to process
 * @param fn - Async function to execute for each item
 * @param options - Concurrency control options
 * @returns Results with successful items and failed items with errors
 *
 * @example
 * const results = await processConcurrently(
 *   articles,
 *   async (article) => processArticle(article),
 *   { concurrency: 20, label: 'Article Processing' }
 * );
 */
export async function processConcurrently<T, R>(
  items: T[],
  fn: (item: T, index: number) => Promise<R>,
  options: ConcurrencyOptions = {}
): Promise<ConcurrencyResult<R>> {
  const { concurrency = 25, label = 'Operation' } = options;

  if (items.length === 0) {
    return { successful: [], failed: [] };
  }

  const startLabel = `${label} (${items.length} items, concurrency: ${concurrency})`;
  const stepId = debugLogger.stepStart('CONCURRENCY', startLabel, {
    itemCount: items.length,
    concurrency
  });
  const startTime = Date.now();

  const successful: R[] = [];
  const failed: Array<{ error: Error; index: number }> = [];

  // Create a queue of promises to maintain concurrency limit
  const executing: Promise<void>[] = [];

  for (let i = 0; i < items.length; i++) {
    const item = items[i];

    // Create promise for this item
    const promise = fn(item, i)
      .then((result) => {
        successful.push(result);
      })
      .catch((error) => {
        debugLogger.warn('CONCURRENCY', `${label}: Item ${i + 1}/${items.length} failed`, {
          error: error.message
        });
        failed.push({ error, index: i });
      })
      .finally(() => {
        // Remove from executing queue when done
        executing.splice(executing.indexOf(promise), 1);
      });

    executing.push(promise);

    // Wait if we've reached the concurrency limit
    if (executing.length >= concurrency) {
      await Promise.race(executing);
    }
  }

  // Wait for all remaining promises to complete
  await Promise.all(executing);

  const duration = Date.now() - startTime;
  debugLogger.stepFinish(stepId, {
    successful: successful.length,
    failed: failed.length,
    avgTimePerItem: `${(duration / items.length).toFixed(0)}ms`,
  });

  return { successful, failed };
}

/**
 * Split an array into chunks of a specified size.
 * Useful for batching operations.
 *
 * @param array - Array to split
 * @param chunkSize - Size of each chunk
 * @returns Array of chunks
 *
 * @example
 * chunkArray([1,2,3,4,5], 2) // [[1,2], [3,4], [5]]
 */
export function chunkArray<T>(array: T[], chunkSize: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < array.length; i += chunkSize) {
    chunks.push(array.slice(i, i + chunkSize));
  }
  return chunks;
}
