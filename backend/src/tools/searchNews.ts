import { DynamicStructuredTool } from '@langchain/core/tools';
import { ChatOpenAI } from '@langchain/openai';
import { z } from 'zod';
import { OpenRouterEmbeddings } from '../agents/llm';
import { debugLogger } from '../utils/debug-logger';
import {
  rewriteQuery,
  hybridSearch,
  rerank,
  deduplicateByArticle,
  assessConfidence,
} from '../search';

const SearchNewsSchema = z.object({
  query: z.string().describe('Search query for crypto news'),
  daysBack: z.number().int().min(1).max(30).optional().describe('Days to look back (1-30, default 7)'),
  limit: z.number().int().min(1).max(20).optional().describe('Max results (1-20, default 7)'),
});

type SearchNewsInput = z.infer<typeof SearchNewsSchema>;

export interface SearchResult {
  sourceNumber: number;
  title: string;
  url: string;
  source: string;
  publishedAt: string;
  quote: string;
  relevance: number;
}

export interface SearchResponse {
  articles: SearchResult[];
  totalFound: number;
  confidence: {
    level: string;
    score: number;
    caveat?: string;
  };
  expandedQuery?: string;
}

export function createSearchNewsTool(
  embeddings: OpenRouterEmbeddings,
  llm: ChatOpenAI
): DynamicStructuredTool {
  return new DynamicStructuredTool({
    name: 'search_crypto_news',
    description:
      'Search for relevant crypto news articles. Uses query expansion, hybrid search (vector + lexical), and intelligent reranking for best results.',
    schema: SearchNewsSchema,
    func: async ({ query, daysBack = 7, limit = 7 }: SearchNewsInput): Promise<string> => {
      const stepId = debugLogger.stepStart('SEARCH_NEWS', 'Executing 4-stage search pipeline', {
        query,
        daysBack,
        limit,
      });

      try {
        // Stage 1: Query Rewriting
        debugLogger.info('SEARCH_NEWS', 'Stage 1: Rewriting query');
        const expandedQuery = await rewriteQuery(query, llm);
        debugLogger.info('SEARCH_NEWS', 'Query expanded', {
          original: query,
          normalized: expandedQuery.normalized,
        });

        // Stage 2: Hybrid Search
        debugLogger.info('SEARCH_NEWS', 'Stage 2: Hybrid search');
        const hybridResults = await hybridSearch(expandedQuery, embeddings, {
          daysBack,
          limit: limit * 3, // Get more candidates for reranking
          vectorThreshold: 0.4,
        });
        debugLogger.info('SEARCH_NEWS', `Found ${hybridResults.length} hybrid candidates`);

        // Stage 3: Reranking
        debugLogger.info('SEARCH_NEWS', 'Stage 3: Reranking');
        const reranked = rerank(expandedQuery.normalized, hybridResults, { topK: limit * 2 });
        const deduplicated = deduplicateByArticle(reranked);
        const finalResults = deduplicated.slice(0, limit);
        debugLogger.info('SEARCH_NEWS', `Reranked to ${finalResults.length} results`);

        // Stage 4: Confidence Assessment
        debugLogger.info('SEARCH_NEWS', 'Stage 4: Confidence assessment');
        const confidence = assessConfidence(finalResults);

        // Format response
        const articles: SearchResult[] = finalResults.map((r, idx) => ({
          sourceNumber: idx + 1,
          title: r.title,
          url: r.url,
          source: r.source,
          publishedAt: r.publishedAt.toISOString(),
          quote: r.chunkContent.substring(0, 500),
          relevance: Math.round(r.finalScore * 100) / 100,
        }));

        const response: SearchResponse = {
          articles,
          totalFound: articles.length,
          confidence: {
            level: confidence.level,
            score: confidence.score,
            caveat: confidence.caveat,
          },
          expandedQuery: expandedQuery.normalized,
        };

        debugLogger.stepFinish(stepId, {
          resultCount: articles.length,
          confidenceLevel: confidence.level,
          confidenceScore: confidence.score,
        });

        return JSON.stringify(response);
      } catch (error) {
        debugLogger.stepError(stepId, 'SEARCH_NEWS', 'Search pipeline error', error);
        throw error;
      }
    },
  }) as DynamicStructuredTool;
}
