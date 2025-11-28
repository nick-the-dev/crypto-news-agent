import { z } from 'zod';

/**
 * Schema for individual source article
 * Note: URL can be "None" or empty if the source doesn't have a URL
 */
export const SourceSchema = z.object({
  title: z.string().describe('Article title'),
  url: z.string().describe('Article URL (can be "None" if unavailable)'),
  publishedAt: z.string().describe('Publication date'),
  quote: z.string().describe('Relevant quote from the article'),
  relevance: z.number().min(0).max(1).describe('Relevance score (0-1)'),
});

export type Source = z.infer<typeof SourceSchema>;

/**
 * Schema for retrieval metrics (tracking vector search performance)
 */
export const RetrievalMetricsSchema = z.object({
  articlesRetrieved: z.number().int().min(0).describe('Articles found by vector similarity'),
  articlesUsed: z.number().int().min(0).describe('Articles used after filtering'),
  vectorScores: z.array(z.object({
    title: z.string(),
    score: z.number(),
  })).describe('Vector similarity scores for retrieved articles'),
});

export type RetrievalMetrics = z.infer<typeof RetrievalMetricsSchema>;

/**
 * Schema for LLM-generated retrieval output (excludes retrievalMetrics to avoid truncation)
 * retrievalMetrics is added programmatically after LLM response
 */
export const RetrievalLLMOutputSchema = z.object({
  summary: z.string().describe('Summary of the news with [Source N] citations'),
  sources: z.array(SourceSchema).describe('Array of source articles'),
  citationCount: z.number().int().min(0).describe('Number of citations used'),
});

export type RetrievalLLMOutput = z.infer<typeof RetrievalLLMOutputSchema>;

/**
 * Schema for Retrieval Agent output (full schema with metrics)
 */
export const RetrievalOutputSchema = z.object({
  summary: z.string().describe('Summary of the news with [Source N] citations'),
  sources: z.array(SourceSchema).describe('Array of source articles'),
  citationCount: z.number().int().min(0).describe('Number of citations used'),
  retrievalMetrics: RetrievalMetricsSchema.optional().nullable().describe('Metrics about the retrieval process'),
});

export type RetrievalOutput = z.infer<typeof RetrievalOutputSchema>;

/**
 * Schema for Validation Agent output
 */
export const ValidationOutputSchema = z.object({
  confidence: z.number().int().min(0).max(100).describe('Confidence score (0-100)'),
  isValid: z.boolean().describe('Whether the response passed validation'),
  issues: z.array(z.string()).describe('List of issues found'),
  citationsVerified: z.number().int().min(0).describe('Number of citations verified'),
  citationsTotal: z.number().int().min(0).describe('Total number of citations'),
});

export type ValidationOutput = z.infer<typeof ValidationOutputSchema>;

/**
 * Schema for single article analysis (MAP phase in Analysis Agent)
 */
export const SingleArticleAnalysisSchema = z.object({
  sentiment: z.enum(['bullish', 'bearish', 'neutral']).describe('Market sentiment of the article'),
  keyPoints: z.array(z.string()).describe('2-3 key points from the article'),
  entities: z.array(z.string()).describe('Mentioned cryptocurrencies, companies, or people'),
});

export type SingleArticleAnalysis = z.infer<typeof SingleArticleAnalysisSchema>;

/**
 * Schema for final response from Supervisor
 */
export const FinalResponseSchema = z.object({
  answer: z.string().describe('Final answer to the user question'),
  sources: z.array(SourceSchema).describe('Source articles used'),
  confidence: z.number().int().min(0).max(100).describe('Overall confidence score'),
  validated: z.boolean().describe('Whether validation passed'),
  metadata: z.object({
    retriesUsed: z.number().int().min(0).describe('Number of retry attempts'),
    timestamp: z.string().describe('Response timestamp'),
    retrievalMetrics: RetrievalMetricsSchema.optional().nullable().describe('Metrics about article retrieval'),
  }).describe('Response metadata'),
});

export type FinalResponse = z.infer<typeof FinalResponseSchema>;
