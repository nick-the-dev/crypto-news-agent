import { SearchResult, RawSearchResult } from '../types';
import { prisma } from '../utils/db';
import { OpenRouterAgent } from '../agents/openrouter-agent';
import { debugLogger } from '../utils/debug-logger';

export async function retrieveRelevantArticles(
  query: string,
  daysBack: number,
  agent: OpenRouterAgent
): Promise<SearchResult[]> {
  const stepId = debugLogger.stepStart('RETRIEVE_ARTICLES', 'Retrieving relevant articles from database', {
    query,
    daysBack
  });

  // Step 1: Generate query embedding
  const embeddingStepId = debugLogger.stepStart('QUERY_EMBEDDING', 'Generating embedding for search query', {
    query
  });
  const queryEmbedding = await agent.generateEmbeddings([query]);
  const embeddingVector = queryEmbedding[0];
  debugLogger.stepFinish(embeddingStepId, {
    embeddingDimension: embeddingVector.length
  });

  // Step 2: Calculate date filter
  const dateFilter = new Date();
  dateFilter.setDate(dateFilter.getDate() - daysBack);

  debugLogger.info('RETRIEVE_ARTICLES', 'Search parameters', {
    query,
    daysBack,
    dateFilter: dateFilter.toISOString(),
    similarityThreshold: 0.5,
    limit: 20
  });

  // Step 3: Execute vector search query
  const searchStepId = debugLogger.stepStart('VECTOR_SEARCH', 'Executing vector similarity search', {
    dateFilter: dateFilter.toISOString()
  });
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

  const topScores = results.length > 0 ? results.slice(0, 5).map(r => ({
    title: r.title.substring(0, 50),
    similarity: r.similarity.toFixed(3)
  })) : [];

  debugLogger.stepFinish(searchStepId, {
    resultCount: results.length,
    topScores
  });

  if (results.length === 0) {
    debugLogger.stepFinish(stepId, { resultCount: 0 });
    return [];
  }

  // Step 4: Score and rank results
  const scoreStepId = debugLogger.stepStart('SCORE_RESULTS', 'Calculating composite scores', {
    resultCount: results.length
  });
  const scoredResults = results.map(r => ({
    ...r,
    score: calculateScore(r)
  }));

  scoredResults.sort((a, b) => b.score - a.score);
  debugLogger.stepFinish(scoreStepId, {
    topScore: scoredResults[0]?.score.toFixed(3),
    bottomScore: scoredResults[scoredResults.length - 1]?.score.toFixed(3)
  });

  // Step 5: Deduplicate by article
  const dedupeStepId = debugLogger.stepStart('DEDUPLICATE', 'Deduplicating results by article', {
    beforeCount: scoredResults.length
  });
  const deduplicatedResults = deduplicateByArticle(scoredResults);
  debugLogger.stepFinish(dedupeStepId, {
    beforeCount: scoredResults.length,
    afterCount: deduplicatedResults.length,
    removed: scoredResults.length - deduplicatedResults.length
  });

  // Step 6: Select top results
  const topResults = deduplicatedResults.slice(0, 20);

  const finalResults = topResults.map(r => ({
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

  debugLogger.stepFinish(stepId, {
    finalResultCount: finalResults.length,
    sources: finalResults.map(r => r.article.source)
  });

  return finalResults;
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
