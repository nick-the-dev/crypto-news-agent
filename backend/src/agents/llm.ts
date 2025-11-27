import { ChatOpenAI } from '@langchain/openai';
import { Embeddings } from '@langchain/core/embeddings';
import { CallbackHandler } from '@langfuse/langchain';
import { RawArticle } from '../types';

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
const LLM_MODEL = 'google/gemini-2.5-flash';
const EMBEDDING_MODEL = 'qwen/qwen3-embedding-8b';
const EMBEDDING_BATCH_SIZE = 100;
const EMBEDDING_MAX_LENGTH = 8000;

/**
 * Model pricing per million tokens (from OpenRouter)
 */
export const MODEL_PRICING = {
  'google/gemini-2.5-flash': {
    inputCostPerMillion: 0.30,
    outputCostPerMillion: 2.50,
  },
  'qwen/qwen3-embedding-8b': {
    inputCostPerMillion: 0.01,
    outputCostPerMillion: 0,
  },
} as const;

/**
 * Calculate cost for token usage
 */
export function calculateCost(
  model: keyof typeof MODEL_PRICING,
  inputTokens: number,
  outputTokens: number
): number {
  const pricing = MODEL_PRICING[model];
  if (!pricing) return 0;

  const inputCost = (inputTokens / 1_000_000) * pricing.inputCostPerMillion;
  const outputCost = (outputTokens / 1_000_000) * pricing.outputCostPerMillion;
  return inputCost + outputCost;
}

/**
 * Create a LangFuse callback handler for tracing LLM calls.
 * Auto-links to any active observation context from @langfuse/tracing.
 * Credentials are read from env vars: LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY, LANGFUSE_HOST
 */
export function createLangfuseHandler(options?: {
  sessionId?: string;
  userId?: string;
  tags?: string[];
}): CallbackHandler {
  const handler = new CallbackHandler({
    sessionId: options?.sessionId,
    userId: options?.userId,
    tags: options?.tags || ['crypto-news-agent'],
    traceMetadata: {
      model: LLM_MODEL,
      modelPricing: MODEL_PRICING[LLM_MODEL as keyof typeof MODEL_PRICING],
    },
    debug: process.env.LANGFUSE_DEBUG === 'true',
  });

  return handler;
}

/**
 * Create ChatOpenAI instance configured for OpenRouter with LangFuse tracing
 */
export function createOpenRouterLLM(options?: {
  temperature?: number;
  maxTokens?: number;
  streaming?: boolean;
}): ChatOpenAI {
  return new ChatOpenAI({
    model: LLM_MODEL,
    apiKey: process.env.OPENROUTER_API_KEY,
    configuration: {
      baseURL: OPENROUTER_BASE_URL,
      defaultHeaders: {
        'HTTP-Referer': process.env.APP_URL || 'http://localhost:3001',
        'X-Title': 'Crypto News Agent',
      },
    },
    temperature: options?.temperature ?? 0.2,
    maxTokens: options?.maxTokens ?? 2000,
    streaming: options?.streaming ?? true,
  });
}

/**
 * OpenRouter Embeddings API response type
 */
interface EmbeddingResponse {
  data: Array<{
    embedding: number[];
    index: number;
    object: string;
  }>;
  model: string;
  usage: {
    prompt_tokens: number;
    total_tokens: number;
  };
}

/**
 * Custom OpenAI Embeddings class for OpenRouter
 */
export class OpenRouterEmbeddings extends Embeddings {
  private model: string;
  private apiKey: string;
  private baseURL: string;

  constructor() {
    super({});
    this.model = EMBEDDING_MODEL;
    this.apiKey = process.env.OPENROUTER_API_KEY!;
    this.baseURL = OPENROUTER_BASE_URL;
  }

  /**
   * Generate embeddings for an array of documents
   */
  async embedDocuments(documents: string[]): Promise<number[][]> {
    const response = await fetch(`${this.baseURL}/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
        'HTTP-Referer': process.env.APP_URL || 'http://localhost:3001',
        'X-Title': 'Crypto News Agent',
      },
      body: JSON.stringify({
        model: this.model,
        input: documents,
      }),
    });

    if (!response.ok) {
      throw new Error(`OpenRouter embedding error: ${response.statusText}`);
    }

    const data = await response.json() as EmbeddingResponse;
    return data.data.map((item) => item.embedding);
  }

  /**
   * Generate embedding for a single query
   */
  async embedQuery(query: string): Promise<number[]> {
    const embeddings = await this.embedDocuments([query]);
    return embeddings[0];
  }
}

/**
 * Create embeddings instance for OpenRouter
 */
export function createOpenRouterEmbeddings(): OpenRouterEmbeddings {
  return new OpenRouterEmbeddings();
}

/**
 * Generate embeddings for texts in batches (for ingestion)
 */
export async function generateEmbeddingsBatch(texts: string[]): Promise<number[][]> {
  const embeddings = createOpenRouterEmbeddings();
  const allEmbeddings: number[][] = [];

  for (let i = 0; i < texts.length; i += EMBEDDING_BATCH_SIZE) {
    const batch = texts.slice(i, i + EMBEDDING_BATCH_SIZE).map(text =>
      text.length > EMBEDDING_MAX_LENGTH ? text.substring(0, EMBEDDING_MAX_LENGTH) : text
    );
    const batchEmbeddings = await embeddings.embedDocuments(batch);
    allEmbeddings.push(...batchEmbeddings);
  }

  return allEmbeddings;
}

/**
 * Generate a summary for a single article
 */
export async function generateSummary(article: RawArticle): Promise<string> {
  const llm = createOpenRouterLLM({ temperature: 0.2, maxTokens: 200, streaming: false });

  const prompt = `Summarize the following crypto news article in 2-3 concise sentences, focusing on the key facts and implications:

Title: ${article.title}

Content: ${article.content.substring(0, 2000)}

Summary:`;

  try {
    const response = await llm.invoke(prompt);
    return typeof response.content === 'string'
      ? response.content.trim()
      : article.content.substring(0, 300) + '...';
  } catch (error) {
    console.error('Failed to generate summary:', error);
    return article.content.substring(0, 300) + '...';
  }
}

/**
 * Attempt to repair common JSON errors
 */
function attemptJSONRepair(jsonString: string): string {
  let repaired = jsonString;
  repaired = repaired.replace(/,(\s*[}\]])/g, '$1');

  if (!repaired.trim().endsWith(']') && !repaired.trim().endsWith('}')) {
    const lastQuoteIndex = repaired.lastIndexOf('"');
    const lastCommaIndex = repaired.lastIndexOf(',');
    const lastBraceIndex = Math.max(repaired.lastIndexOf('{'), repaired.lastIndexOf('['));

    if (lastQuoteIndex > lastCommaIndex && lastQuoteIndex > lastBraceIndex) {
      repaired = repaired.substring(0, lastQuoteIndex + 1);
      repaired += '\n  }\n]';
    } else {
      repaired += '\n]';
    }
  }

  return repaired;
}

/**
 * Generate summaries for multiple articles in a single batch AI call
 */
export async function generateSummariesBatch(
  articles: RawArticle[],
  retryCount = 0
): Promise<Map<string, string>> {
  if (articles.length === 0) {
    return new Map();
  }

  const MAX_RETRIES = 2;
  const llm = createOpenRouterLLM({
    temperature: 0.2,
    maxTokens: 4000 * articles.length,
    streaming: false
  });

  const articlesText = articles.map((article, idx) =>
    `[ARTICLE ${idx + 1}]
URL: ${article.url}
Title: ${article.title}
Content: ${article.content.substring(0, 2000)}
`
  ).join('\n---\n\n');

  const prompt = `You are a JSON generator. Summarize each crypto news article below.

CRITICAL REQUIREMENTS:
1. Output ONLY a valid JSON array - no other text before or after
2. You MUST complete all ${articles.length} summaries - do not truncate
3. Escape all quotes inside strings as \"
4. Each summary must be 2-3 complete sentences
5. The JSON must be valid and parseable

Format: Array of objects with:
- "url": exact article URL (string)
- "summary": 2-3 sentence summary (string)

${articlesText}

Return ONLY the JSON array, ensuring it's complete and valid:`;

  try {
    const response = await llm.invoke(prompt);
    const content = typeof response.content === 'string' ? response.content.trim() : '';

    if (!content) {
      throw new Error('Empty response from AI');
    }

    // Strip markdown code blocks if present
    let jsonContent = content;
    if (content.startsWith('```')) {
      jsonContent = content
        .replace(/^```(?:json)?\s*\n?/, '')
        .replace(/\n?```\s*$/, '')
        .trim();
    }

    let summaries: Array<{ url: string; summary: string }>;
    try {
      summaries = JSON.parse(jsonContent);
    } catch (parseError) {
      console.error('JSON parse failed. Response length:', jsonContent.length);
      console.warn('Attempting to repair JSON...');
      try {
        const repairedContent = attemptJSONRepair(jsonContent);
        summaries = JSON.parse(repairedContent);
        console.log('✓ JSON repair successful!');
      } catch (repairError) {
        if (retryCount < MAX_RETRIES) {
          console.warn(`JSON repair failed. Retrying batch (attempt ${retryCount + 1}/${MAX_RETRIES})...`);
          await new Promise(resolve => setTimeout(resolve, 1000 * (retryCount + 1)));
          return generateSummariesBatch(articles, retryCount + 1);
        }
        throw new Error(`JSON parsing failed after ${MAX_RETRIES} retries`);
      }
    }

    const summaryMap = new Map<string, string>();
    for (const { url, summary } of summaries) {
      if (url && summary) {
        summaryMap.set(url, summary);
      }
    }

    // Fill in fallbacks for any missing summaries
    for (const article of articles) {
      if (!summaryMap.has(article.url)) {
        console.warn(`No summary generated for ${article.url}, using fallback`);
        summaryMap.set(article.url, article.content.substring(0, 300) + '...');
      }
    }

    return summaryMap;
  } catch (error) {
    console.error('Failed to generate batch summaries:', error);
    const fallbackMap = new Map<string, string>();
    for (const article of articles) {
      fallbackMap.set(article.url, article.content.substring(0, 300) + '...');
    }
    return fallbackMap;
  }
}
