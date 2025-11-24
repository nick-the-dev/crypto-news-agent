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
 * Schema for Retrieval Agent output
 */
export const RetrievalOutputSchema = z.object({
  summary: z.string().describe('Summary of the news with [Source N] citations'),
  sources: z.array(SourceSchema).describe('Array of source articles'),
  citationCount: z.number().int().min(0).describe('Number of citations used'),
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
  }).describe('Response metadata'),
});

export type FinalResponse = z.infer<typeof FinalResponseSchema>;
