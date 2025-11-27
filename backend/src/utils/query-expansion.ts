/**
 * Dynamic query expansion using LLM and embeddings
 * No hardcoded dictionaries - everything is semantic
 */

import { ChatOpenAI } from '@langchain/openai';
import { ChatPromptTemplate } from '@langchain/core/prompts';
import { z } from 'zod';
import { debugLogger } from './debug-logger';

/**
 * Schema for LLM query expansion response
 */
const QueryExpansionSchema = z.object({
  isTopicSpecific: z.boolean().describe('Whether the query is about a specific crypto topic/asset'),
  searchTerms: z.array(z.string()).describe('List of search terms to find relevant articles'),
  category: z.string().nullable().describe('Category like "memecoin", "defi", "nft", "bitcoin", "ethereum", "regulation", "security", etc. Null if general market query.'),
});

type QueryExpansion = z.infer<typeof QueryExpansionSchema>;

const EXPANSION_PROMPT = `You are a crypto news search query optimizer. Given a user question, extract search terms that will help find relevant news articles.

User Question: {question}

Your task:
1. Determine if this is about a specific crypto topic (like memecoins, DeFi, NFTs, Bitcoin, etc.) or a general market question
2. Generate 5-10 search terms that would match relevant article titles and content
3. Include:
   - The main topic/asset names
   - Common abbreviations (BTC for Bitcoin, ETH for Ethereum)
   - Related project names if asking about a category (e.g., for memecoins: DOGE, SHIB, PEPE, BONK)
   - Common variations (memecoin, meme coin, meme token)

Be comprehensive but focused. Only include terms directly relevant to the query.`;

/**
 * Expand a query using LLM to generate relevant search terms
 * This replaces hardcoded dictionaries with dynamic understanding
 */
export async function expandQueryWithLLM(
  question: string,
  llm: ChatOpenAI
): Promise<QueryExpansion> {
  const stepId = debugLogger.stepStart('QUERY_EXPANSION', 'Expanding query with LLM', {
    question: question.substring(0, 50),
  });

  try {
    const prompt = ChatPromptTemplate.fromTemplate(EXPANSION_PROMPT);
    const formattedPrompt = await prompt.invoke({ question });
    const structuredLLM = llm.withStructuredOutput(QueryExpansionSchema);

    const result = (await structuredLLM.invoke(formattedPrompt)) as QueryExpansion;

    debugLogger.stepFinish(stepId, {
      isTopicSpecific: result.isTopicSpecific,
      searchTermsCount: result.searchTerms.length,
      category: result.category,
      searchTerms: result.searchTerms.slice(0, 5),
    });

    return result;
  } catch (error) {
    debugLogger.stepError(stepId, 'QUERY_EXPANSION', 'Failed to expand query', error);
    // Fallback: extract basic terms from the question
    return {
      isTopicSpecific: false,
      searchTerms: question.toLowerCase().split(/\W+/).filter(w => w.length > 3),
      category: null,
    };
  }
}

/**
 * Calculate cosine similarity between two vectors
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  return denominator === 0 ? 0 : dotProduct / denominator;
}

