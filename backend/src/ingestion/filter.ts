import { RawArticle } from '../types';
import { prisma } from '../utils/db';
import { debugLogger } from '../utils/debug-logger';

/**
 * Normalize URL by stripping tracking parameters
 * Keeps the base URL path but removes utm_*, timestamp, cache-busting params
 */
export function normalizeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const paramsToRemove = [
      'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
      'timestamp', 'ttt', '_t', '_ts', '_dc', '_refresh', '_rnd', '__', 'r', 'nc', 'rand', '_q'
    ];

    for (const param of paramsToRemove) {
      parsed.searchParams.delete(param);
    }

    // If all params were tracking params, return URL without query string
    if (parsed.searchParams.toString() === '') {
      return `${parsed.origin}${parsed.pathname}`;
    }

    return parsed.toString();
  } catch {
    return url;
  }
}

export async function filterNewArticles(articles: RawArticle[]): Promise<RawArticle[]> {
  if (articles.length === 0) {
    return [];
  }

  // Get existing articles by URL (both raw and normalized)
  const urls = articles.map(a => a.url);
  const normalizedUrls = articles.map(a => normalizeUrl(a.url));
  const titles = articles.map(a => a.title.toLowerCase().trim());

  // Check for existing articles by URL or normalized URL
  const existingByUrl = await prisma.article.findMany({
    where: {
      OR: [
        { url: { in: urls } },
        { url: { in: normalizedUrls } },
      ]
    },
    select: { url: true, title: true }
  });

  // Also check by title to catch any duplicates with completely different URLs
  const existingByTitle = await prisma.article.findMany({
    where: {
      title: { in: articles.map(a => a.title), mode: 'insensitive' }
    },
    select: { title: true }
  });

  const existingUrls = new Set(existingByUrl.map(a => a.url));
  const existingNormalizedUrls = new Set(existingByUrl.map(a => normalizeUrl(a.url)));
  const existingTitles = new Set(existingByTitle.map(a => a.title.toLowerCase().trim()));

  // Filter out articles that already exist (by URL or title)
  const newArticles = articles.filter(article => {
    const normalizedUrl = normalizeUrl(article.url);
    const normalizedTitle = article.title.toLowerCase().trim();

    // Skip if exact URL exists
    if (existingUrls.has(article.url)) return false;

    // Skip if normalized URL exists
    if (existingNormalizedUrls.has(normalizedUrl)) return false;

    // Skip if title already exists
    if (existingTitles.has(normalizedTitle)) return false;

    return true;
  });

  // Also deduplicate within the current batch by title
  const seenTitles = new Set<string>();
  const deduplicatedArticles = newArticles.filter(article => {
    const normalizedTitle = article.title.toLowerCase().trim();
    if (seenTitles.has(normalizedTitle)) {
      return false;
    }
    seenTitles.add(normalizedTitle);
    return true;
  });

  if (newArticles.length !== deduplicatedArticles.length) {
    debugLogger.info('INGESTION_FILTER', 'Deduplicated within batch', {
      beforeDedup: newArticles.length,
      afterDedup: deduplicatedArticles.length,
      removed: newArticles.length - deduplicatedArticles.length,
    });
  }

  return deduplicatedArticles;
}
