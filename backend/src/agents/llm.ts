import { ChatOpenAI } from '@langchain/openai';
import { Embeddings } from '@langchain/core/embeddings';
import { CallbackHandler } from '@langfuse/langchain';

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
const LLM_MODEL = 'google/gemini-2.5-flash';
const EMBEDDING_MODEL = 'qwen/qwen3-embedding-8b';

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
  return new CallbackHandler({
    sessionId: options?.sessionId,
    userId: options?.userId,
    tags: options?.tags || ['crypto-news-agent'],
    traceMetadata: {
      model: LLM_MODEL,
      modelPricing: MODEL_PRICING[LLM_MODEL as keyof typeof MODEL_PRICING],
    },
  });
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
