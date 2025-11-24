import { ChatOpenAI } from '@langchain/openai';
import { Embeddings } from '@langchain/core/embeddings';
import { CallbackHandler } from '@langfuse/langchain';

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
const LLM_MODEL = 'google/gemini-2.5-flash';
const EMBEDDING_MODEL = 'qwen/qwen3-embedding-8b';

/**
 * Create a LangFuse callback handler for tracing LLM calls
 * Requires environment variables:
 * - LANGFUSE_PUBLIC_KEY
 * - LANGFUSE_SECRET_KEY
 * - LANGFUSE_BASE_URL (optional, defaults to cloud)
 */
export function createLangfuseHandler(options?: {
  sessionId?: string;
  userId?: string;
  tags?: string[];
}): CallbackHandler {
  return new CallbackHandler({
    publicKey: process.env.LANGFUSE_PUBLIC_KEY,
    secretKey: process.env.LANGFUSE_SECRET_KEY,
    baseUrl: process.env.LANGFUSE_BASE_URL,
    sessionId: options?.sessionId,
    userId: options?.userId,
    tags: options?.tags || ['crypto-news-agent'],
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
