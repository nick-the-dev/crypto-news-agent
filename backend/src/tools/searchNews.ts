import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { prisma } from '../utils/db';
import { OpenRouterEmbeddings } from '../agents/llm';
import { debugLogger } from '../utils/debug-logger';

// Simplified schema to avoid type recursion issues
const SearchNewsSchema = z.object({
  query: z.string(),
  daysBack: z.number().int().min(1).max(30).optional(),
  limit: z.number().int().min(1).max(20).optional(),
});

type SearchNewsInput = z.infer<typeof SearchNewsSchema>;

interface RawSearchResult {
  chunkId: string;
  chunkContent: string;
  chunkIndex: number;
  isIntro: boolean;
  isSummary: boolean;
  similarity: number;
  articleId: string;
  title: string;
  summary: string;
  source: string;
  url: string;
  publishedAt: Date;
}

/**
 * Calculate composite score for search result
 */
function calculateScore(result: RawSearchResult): number {
  const similarity = result.similarity;
  const introBoost = result.isIntro ? 1.2 : 1.0;
  const summaryBoost = result.isSummary ? 1.5 : 1.0;
  const daysAgo = (Date.now() - result.publishedAt.getTime()) / (1000 * 60 * 60 * 24);
  const recencyWeight = Math.exp(-daysAgo * 0.15);

  return similarity * introBoost * summaryBoost * recencyWeight;
}

/**
 * Deduplicate results by article, keeping highest score
 */
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

/**
 * Create searchNews tool for vector search
 */
export function createSearchNewsTool(embeddings: OpenRouterEmbeddings): DynamicStructuredTool {
  return new DynamicStructuredTool({
    name: 'search_crypto_news',
    description: 'Search for relevant crypto news articles using semantic search. Returns articles with titles, URLs, summaries, and relevant quotes. Parameters: query (string), daysBack (number 1-30, default 7), limit (number 1-20, default 7).',
    schema: SearchNewsSchema,
    func: async ({ query, daysBack, limit }: SearchNewsInput) => {
      const finalDaysBack = daysBack ?? 7;
      const finalLimit = limit ?? 7;
      const stepId = debugLogger.stepStart('TOOL_SEARCH_NEWS', 'Executing search_crypto_news tool', {
        query,
        daysBack: finalDaysBack,
        limit: finalLimit,
      });

      try {
        // Step 1: Generate query embedding
        debugLogger.info('TOOL_SEARCH_NEWS', 'Generating embedding for query');
        const queryEmbedding = await embeddings.embedQuery(query);

        // Step 2: Calculate date filter
        const dateFilter = new Date();
        dateFilter.setDate(dateFilter.getDate() - finalDaysBack);

        // Step 3: Execute vector search
        debugLogger.info('TOOL_SEARCH_NEWS', 'Executing vector search', {
          dateFilter: dateFilter.toISOString(),
          similarityThreshold: 0.5,
        });

        const results = await prisma.$queryRaw<RawSearchResult[]>`
          SELECT
            c.id as "chunkId",
            c.content as "chunkContent",
            c."chunkIndex",
            c."isIntro",
            c."isSummary",
            1 - (e.embedding <=> ${JSON.stringify(queryEmbedding)}::vector) as similarity,
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
            AND (1 - (e.embedding <=> ${JSON.stringify(queryEmbedding)}::vector)) >= 0.5
          ORDER BY similarity DESC
          LIMIT 20
        `;

        if (results.length === 0) {
          debugLogger.stepFinish(stepId, { resultCount: 0 });
          return JSON.stringify({
            message: 'No relevant articles found for the given query and timeframe.',
            articles: [],
          });
        }

        // Step 4: Score and rank results
        const scoredResults = results.map(r => ({
          ...r,
          score: calculateScore(r),
        }));
        scoredResults.sort((a, b) => b.score - a.score);

        // Step 5: Deduplicate by article
        const deduplicatedResults = deduplicateByArticle(scoredResults);

        // Step 6: Select top results
        const topResults = deduplicatedResults.slice(0, finalLimit);

        const articles = topResults.map((r, index) => ({
          sourceNumber: index + 1,
          title: r.title,
          url: r.url,
          publishedAt: r.publishedAt.toISOString(),
          quote: r.chunkContent,
          relevance: Math.round(r.similarity * 100) / 100,
        }));

        debugLogger.stepFinish(stepId, {
          resultCount: articles.length,
          sources: articles.map(a => a.title.substring(0, 50)),
        });

        return JSON.stringify({
          articles,
          totalFound: articles.length,
        });
      } catch (error) {
        debugLogger.stepError(stepId, 'TOOL_SEARCH_NEWS', 'Error in search_crypto_news tool', error);
        throw error;
      }
    },
  }) as DynamicStructuredTool;
}
