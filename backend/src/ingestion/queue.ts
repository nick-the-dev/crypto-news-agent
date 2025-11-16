import { IngestionStats } from '../types';
import { fetchAllRSS } from './rss-fetcher';
import { filterNewArticles } from './filter';
import { processNewArticles } from './processor';
import { OpenRouterAgent } from '../agents/openrouter-agent';
import { RSS_SOURCES } from './sources';

class IngestionQueue {
  private isIngesting = false;
  private lastResult: IngestionStats | null = null;
  private lastIngestTime = 0;
  private waitingRequests: Array<(result: IngestionStats) => void> = [];

  async ingest(agent: OpenRouterAgent): Promise<IngestionStats> {
    if (Date.now() - this.lastIngestTime < 10000 && this.lastResult) {
      return this.lastResult;
    }

    if (this.isIngesting) {
      return new Promise(resolve => {
        this.waitingRequests.push(resolve);
      });
    }

    this.isIngesting = true;

    try {
      const articles = await fetchAllRSS(RSS_SOURCES);
      const newArticles = await filterNewArticles(articles);
      const { processed, errors } = await processNewArticles(newArticles, agent);

      const result: IngestionStats = {
        fetched: articles.length,
        existing: articles.length - newArticles.length,
        new: newArticles.length,
        processed,
        errors
      };

      this.lastResult = result;
      this.lastIngestTime = Date.now();

      this.waitingRequests.forEach(resolve => resolve(result));
      this.waitingRequests = [];

      return result;
    } finally {
      this.isIngesting = false;
    }
  }
}

export const ingestionQueue = new IngestionQueue();
