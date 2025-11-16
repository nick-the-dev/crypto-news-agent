import OpenAI from 'openai';
import { RawArticle } from '../types';

const EMBEDDING_MODEL = 'qwen/qwen3-embedding-0.6b';
const LLM_MODEL = 'google/gemini-2.5-flash';

export class OpenRouterAgent {
  private client: OpenAI;

  constructor(apiKey: string) {
    if (!apiKey) {
      throw new Error('OpenRouter API key is required');
    }

    this.client = new OpenAI({
      baseURL: 'https://openrouter.ai/api/v1',
      apiKey,
      defaultHeaders: {
        'HTTP-Referer': 'https://crypto-news-agent.local',
        'X-Title': 'Crypto News Agent'
      }
    });
  }

  async generateEmbeddings(texts: string[]): Promise<number[][]> {
    const batchSize = 100;
    const allEmbeddings: number[][] = [];

    for (let i = 0; i < texts.length; i += batchSize) {
      const batch = texts.slice(i, i + batchSize).map(text =>
        text.length > 8000 ? text.substring(0, 8000) : text
      );

      try {
        const response = await this.client.embeddings.create({
          model: EMBEDDING_MODEL,
          input: batch
        });

        allEmbeddings.push(...response.data.map(item => item.embedding));
      } catch (error) {
        console.error(`Failed to generate embeddings for batch ${i / batchSize + 1}:`, error);
        throw error;
      }
    }

    return allEmbeddings;
  }

  async generateSummary(article: RawArticle): Promise<string> {
    const prompt = `Summarize the following crypto news article in 2-3 concise sentences, focusing on the key facts and implications:

Title: ${article.title}

Content: ${article.content.substring(0, 2000)}

Summary:`;

    try {
      const response = await this.client.chat.completions.create({
        model: LLM_MODEL,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.3,
        max_tokens: 200
      });

      return response.choices[0].message.content?.trim() || article.content.substring(0, 300) + '...';
    } catch (error) {
      console.error('Failed to generate summary:', error);
      return article.content.substring(0, 300) + '...';
    }
  }

  async *streamAnswer(systemPrompt: string, userPrompt: string): AsyncGenerator<string> {
    const stream = await this.client.chat.completions.create({
      model: LLM_MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      temperature: 0.2,
      max_tokens: 2000,
      stream: true
    });

    for await (const chunk of stream) {
      const content = chunk.choices[0]?.delta?.content;
      if (content) {
        yield content;
      }
    }
  }
}
