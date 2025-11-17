import Parser from 'rss-parser';
import { RSSSource, RawArticle } from '../types';
import { stripHtml, sleep } from '../utils/html';

const parser = new Parser({
  customFields: {
    item: [
      ['content:encoded', 'contentEncoded'],
      ['dc:creator', 'creator']
    ]
  }
});

async function fetchWithRetry(url: string, maxRetries = 3): Promise<any> {
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30000);

      // Special handling for Cointelegraph - their RSS is missing version attribute
      if (url.includes('cointelegraph.com')) {
        console.log('[RSS] Special handling for Cointelegraph...');
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
          console.log('[RSS] Added version="2.0" attribute to Cointelegraph <rss> tag');
        }

        clearTimeout(timeout);
        return await parser.parseString(fixedXml);
      }

      const feed = await parser.parseURL(url);
      clearTimeout(timeout);
      return feed;
    } catch (error) {
      lastError = error as Error;
      console.error(`Fetch attempt ${attempt}/${maxRetries} failed for ${url}:`, error);

      if (attempt < maxRetries) {
        const delay = Math.pow(2, attempt - 1) * 1000;
        await sleep(delay);
      }
    }
  }

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
  try {
    const feed = await fetchWithRetry(source.url);

    return feed.items
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
  } catch (error) {
    console.error(`Failed to fetch ${source.name}:`, error);
    return [];
  }
}

export async function fetchAllRSS(sources: RSSSource[]): Promise<RawArticle[]> {
  const results = await Promise.allSettled(
    sources.map(source => fetchSource(source))
  );

  const articles: RawArticle[] = [];
  const errors: string[] = [];

  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    if (result.status === 'fulfilled') {
      articles.push(...result.value);
    } else {
      errors.push(`${sources[i].name}: ${result.reason?.message || 'Unknown error'}`);
    }
  }

  if (articles.length === 0) {
    throw new Error(`All RSS sources failed: ${errors.join(', ')}`);
  }

  if (errors.length > 0) {
    console.warn('Some RSS sources failed:', errors);
  }

  return articles;
}
