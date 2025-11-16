import { SearchResult, RawSearchResult } from '../types';
import { prisma } from '../utils/db';
import { OpenRouterAgent } from '../agents/openrouter-agent';

export async function retrieveRelevantArticles(
  query: string,
  daysBack: number,
  agent: OpenRouterAgent
): Promise<SearchResult[]> {
  const queryEmbedding = await agent.generateEmbeddings([query]);
  const embeddingVector = queryEmbedding[0];

  const dateFilter = new Date();
  dateFilter.setDate(dateFilter.getDate() - daysBack);

  console.log(`[Search] Query: "${query}"`);
  console.log(`[Search] Days back: ${daysBack}, Date filter: ${dateFilter.toISOString()}`);

  const results = await prisma.$queryRaw<RawSearchResult[]>`
    SELECT
      c.id as "chunkId",
      c.content as "chunkContent",
      c."chunkIndex",
      c."isIntro",
      c."isSummary",
      1 - (e.embedding <=> ${JSON.stringify(embeddingVector)}::vector) as similarity,
      a.id as "articleId",
      a.title,
      a.summary,
      a.source,
      a.url,
      a."publishedAt"
    FROM "ArticleEmbedding" e
    JOIN "ArticleChunk" c ON e."chunkId" = c.id
    JOIN "Article" a ON c."articleId" = a.id
    WHERE
      a."publishedAt" >= ${dateFilter}
      AND (1 - (e.embedding <=> ${JSON.stringify(embeddingVector)}::vector)) >= 0.5
    ORDER BY similarity DESC
    LIMIT 20
  `;

  console.log(`[Search] Found ${results.length} results with similarity >= 0.5`);
  if (results.length > 0) {
    console.log(`[Search] Top 5 similarity scores:`, results.slice(0, 5).map(r => ({
      title: r.title.substring(0, 50),
      similarity: r.similarity.toFixed(3)
    })));
  }

  if (results.length === 0) {
    return [];
  }

  const scoredResults = results.map(r => ({
    ...r,
    score: calculateScore(r)
  }));

  scoredResults.sort((a, b) => b.score - a.score);

  const deduplicatedResults = deduplicateByArticle(scoredResults);

  const topResults = deduplicatedResults.slice(0, 7);

  return topResults.map(r => ({
    article: {
      id: r.articleId,
      title: r.title,
      summary: r.summary,
      source: r.source,
      url: r.url,
      publishedAt: r.publishedAt
    },
    chunk: {
      content: r.chunkContent,
      chunkIndex: r.chunkIndex,
      isIntro: r.isIntro,
      isSummary: r.isSummary
    },
    relevance: Math.round(r.similarity * 100),
    recencyHours: (Date.now() - r.publishedAt.getTime()) / (1000 * 60 * 60)
  }));
}

function calculateScore(result: RawSearchResult & { score?: number }): number {
  const similarity = result.similarity;

  const introBoost = result.isIntro ? 1.2 : 1.0;
  const summaryBoost = result.isSummary ? 1.5 : 1.0;

  const daysAgo = (Date.now() - result.publishedAt.getTime()) / (1000 * 60 * 60 * 24);
  const recencyWeight = Math.exp(-daysAgo * 0.15);

  return similarity * introBoost * summaryBoost * recencyWeight;
}

function deduplicateByArticle(
  results: (RawSearchResult & { score: number })[]
): (RawSearchResult & { score: number })[] {
  const articleMap = new Map<string, RawSearchResult & { score: number }>();

  for (const result of results) {
    const existing = articleMap.get(result.articleId);
    if (!existing || result.score > existing.score) {
      articleMap.set(result.articleId, result);
    }
  }

  return Array.from(articleMap.values());
}
