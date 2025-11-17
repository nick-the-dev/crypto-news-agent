import Parser from 'rss-parser';
import { RSSSource, RawArticle } from '../types';
import { stripHtml, sleep } from '../utils/html';
import { debugLogger } from '../utils/debug-logger';

const parser = new Parser({
  customFields: {
    item: [
      ['content:encoded', 'contentEncoded'],
      ['dc:creator', 'creator']
    ]
  }
});

async function fetchWithRetry(url: string, maxRetries = 3): Promise<any> {
  const stepId = debugLogger.stepStart('RSS_FETCH_RETRY', `Fetching RSS feed with retry logic`, {
    url,
    maxRetries
  });

  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const attemptStepId = debugLogger.stepStart('RSS_FETCH_ATTEMPT', `Attempt ${attempt}/${maxRetries}`, {
      url,
      attempt
    });

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30000);

      // Special handling for Cointelegraph - their RSS is missing version attribute
      if (url.includes('cointelegraph.com')) {
        debugLogger.info('RSS_FETCH_ATTEMPT', 'Special handling for Cointelegraph RSS feed');
        const https = await import('https');

        const xmlContent = await new Promise<string>((resolve, reject) => {
          https.get(url, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => resolve(data));
            res.on('error', reject);
          }).on('error', reject);
        });

        // Add version="2.0" if missing from <rss> tag specifically
        let fixedXml = xmlContent;
        const rssTagMatch = xmlContent.match(/<rss[^>]*>/);
        if (rssTagMatch && !rssTagMatch[0].includes('version=')) {
          fixedXml = xmlContent.replace(/<rss\s+/, '<rss version="2.0" ');
          debugLogger.info('RSS_FETCH_ATTEMPT', 'Added version="2.0" attribute to Cointelegraph <rss> tag');
        }

        clearTimeout(timeout);
        const feed = await parser.parseString(fixedXml);
        debugLogger.stepFinish(attemptStepId, { itemCount: feed.items?.length || 0 });
        debugLogger.stepFinish(stepId, { itemCount: feed.items?.length || 0, attempts: attempt });
        return feed;
      }

      const feed = await parser.parseURL(url);
      clearTimeout(timeout);
      debugLogger.stepFinish(attemptStepId, { itemCount: feed.items?.length || 0 });
      debugLogger.stepFinish(stepId, { itemCount: feed.items?.length || 0, attempts: attempt });
      return feed;
    } catch (error) {
      lastError = error as Error;
      debugLogger.stepError(attemptStepId, 'RSS_FETCH_ATTEMPT', `Attempt ${attempt} failed`, error);
      console.error(`Fetch attempt ${attempt}/${maxRetries} failed for ${url}:`, error);

      if (attempt < maxRetries) {
        const delay = Math.pow(2, attempt - 1) * 1000;
        debugLogger.info('RSS_FETCH_RETRY', `Retrying after ${delay}ms delay`, { delay, nextAttempt: attempt + 1 });
        await sleep(delay);
      }
    }
  }

  debugLogger.stepError(stepId, 'RSS_FETCH_RETRY', 'All retry attempts exhausted', lastError);
  throw lastError;
}

function extractContent(item: any, source: RSSSource): string {
  const primaryContent = item[source.contentField === 'content:encoded' ? 'contentEncoded' : 'description'];
  const fallbackContent = source.fallbackField ? item[source.fallbackField] : null;

  const rawContent = primaryContent || fallbackContent || item.content || '';
  return stripHtml(rawContent);
}

function parseDate(dateString: string | undefined): Date {
  if (!dateString) return new Date();

  const parsed = new Date(dateString);
  return isNaN(parsed.getTime()) ? new Date() : parsed;
}

async function fetchSource(source: RSSSource): Promise<RawArticle[]> {
  const stepId = debugLogger.stepStart('RSS_FETCH_SOURCE', `Fetching articles from ${source.name}`, {
    sourceName: source.name,
    url: source.url
  });

  try {
    const feed = await fetchWithRetry(source.url);

    debugLogger.info('RSS_FETCH_SOURCE', 'Processing feed items', {
      rawItemCount: feed.items.length
    });

    const articles = feed.items
      .filter((item: any) => item.link && item.title)
      .map((item: any) => ({
        url: item.link!,
        title: item.title!,
        content: extractContent(item, source),
        publishedAt: parseDate(item.pubDate || item.isoDate),
        source: source.name,
        author: item.creator || item.author || null
      }))
      .filter((article: RawArticle) => article.content.length > 100);

    debugLogger.stepFinish(stepId, {
      rawItemCount: feed.items.length,
      validArticleCount: articles.length,
      filteredOut: feed.items.length - articles.length
    });

    return articles;
  } catch (error) {
    debugLogger.stepError(stepId, 'RSS_FETCH_SOURCE', `Failed to fetch from ${source.name}`, error);
    console.error(`Failed to fetch ${source.name}:`, error);
    return [];
  }
}

export async function fetchAllRSS(sources: RSSSource[]): Promise<RawArticle[]> {
  const stepId = debugLogger.stepStart('RSS_FETCH_ALL', 'Fetching from all RSS sources', {
    sourceCount: sources.length,
    sources: sources.map(s => s.name)
  });

  const results = await Promise.allSettled(
    sources.map(source => fetchSource(source))
  );

  const articles: RawArticle[] = [];
  const errors: string[] = [];

  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    if (result.status === 'fulfilled') {
      articles.push(...result.value);
      debugLogger.info('RSS_FETCH_ALL', `Source succeeded: ${sources[i].name}`, {
        articleCount: result.value.length
      });
    } else {
      const errorMsg = `${sources[i].name}: ${result.reason?.message || 'Unknown error'}`;
      errors.push(errorMsg);
      debugLogger.warn('RSS_FETCH_ALL', `Source failed: ${sources[i].name}`, {
        error: result.reason?.message || 'Unknown error'
      });
    }
  }

  if (articles.length === 0) {
    debugLogger.stepError(stepId, 'RSS_FETCH_ALL', 'All RSS sources failed', new Error(errors.join(', ')));
    throw new Error(`All RSS sources failed: ${errors.join(', ')}`);
  }

  if (errors.length > 0) {
    console.warn('Some RSS sources failed:', errors);
  }

  debugLogger.stepFinish(stepId, {
    totalArticles: articles.length,
    successfulSources: sources.length - errors.length,
    failedSources: errors.length,
    errors: errors.length > 0 ? errors : undefined
  });

  return articles;
}
