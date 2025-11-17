import { IngestionStats } from '../types';
import { fetchAllRSS } from './rss-fetcher';
import { filterNewArticles } from './filter';
import { processNewArticles } from './processor';
import { OpenRouterAgent } from '../agents/openrouter-agent';
import { RSS_SOURCES } from './sources';
import { debugLogger } from '../utils/debug-logger';

class IngestionQueue {
  private isIngesting = false;
  private waitingRequests: Array<(result: IngestionStats) => void> = [];

  async ingest(agent: OpenRouterAgent): Promise<IngestionStats> {
    const stepId = debugLogger.stepStart('INGESTION', 'Starting ingestion process', {
      waitingRequests: this.waitingRequests.length,
      isIngesting: this.isIngesting
    });

    // Check if already ingesting
    if (this.isIngesting) {
      debugLogger.info('INGESTION', 'Ingestion already in progress, queuing request', {
        queuePosition: this.waitingRequests.length + 1
      });
      return new Promise(resolve => {
        this.waitingRequests.push(resolve);
      });
    }

    this.isIngesting = true;

    try {
      // Step 1: Fetch all RSS feeds
      debugLogger.info('INGESTION', 'Fetching articles from all RSS sources');
      const articles = await fetchAllRSS(RSS_SOURCES);

      // Step 2: Filter new articles
      const filterStepId = debugLogger.stepStart('INGESTION_FILTER', 'Filtering for new articles', {
        totalArticles: articles.length
      });
      const newArticles = await filterNewArticles(articles);
      debugLogger.stepFinish(filterStepId, {
        totalArticles: articles.length,
        newArticles: newArticles.length,
        existingArticles: articles.length - newArticles.length
      });

      // Step 3: Process new articles
      const processStepId = debugLogger.stepStart('INGESTION_PROCESS', 'Processing new articles', {
        articleCount: newArticles.length
      });
      const { processed, errors } = await processNewArticles(newArticles, agent);
      debugLogger.stepFinish(processStepId, {
        processed,
        failed: errors.length,
        errors: errors.length > 0 ? errors : undefined
      });

      // Step 4: Build result
      const result: IngestionStats = {
        fetched: articles.length,
        existing: articles.length - newArticles.length,
        new: newArticles.length,
        processed,
        errors
      };

      // Notify waiting requests
      if (this.waitingRequests.length > 0) {
        debugLogger.info('INGESTION', 'Notifying waiting requests', {
          waitingCount: this.waitingRequests.length
        });
        this.waitingRequests.forEach(resolve => resolve(result));
        this.waitingRequests = [];
      }

      debugLogger.stepFinish(stepId, result);
      return result;
    } catch (error) {
      debugLogger.stepError(stepId, 'INGESTION', 'Ingestion failed', error);
      throw error;
    } finally {
      this.isIngesting = false;
    }
  }
}

export const ingestionQueue = new IngestionQueue();
