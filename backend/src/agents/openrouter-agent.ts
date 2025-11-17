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

    // Disable OpenAI SDK debug logging
    process.env.OPENAI_LOG = 'off';

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
        temperature: 0.2,
        max_tokens: 200
      });

      return response.choices[0].message.content?.trim() || article.content.substring(0, 300) + '...';
    } catch (error) {
      console.error('Failed to generate summary:', error);
      return article.content.substring(0, 300) + '...';
    }
  }

  /**
   * Generate summaries for multiple articles in a single batch AI call.
   * This is much more efficient than calling generateSummary() for each article.
   *
   * @param articles - Array of articles to summarize
   * @returns Map of article URLs to their summaries
   */
  async generateSummariesBatch(articles: RawArticle[]): Promise<Map<string, string>> {
    if (articles.length === 0) {
      return new Map();
    }

    // Build a prompt that asks for summaries of all articles at once
    const articlesText = articles.map((article, idx) =>
      `[ARTICLE ${idx + 1}]
URL: ${article.url}
Title: ${article.title}
Content: ${article.content.substring(0, 2000)}
`
    ).join('\n---\n\n');

    const prompt = `You are a JSON generator. Summarize each crypto news article below.

CRITICAL: Output ONLY valid JSON. Escape all quotes and special characters properly.

Format: JSON array where each element has:
- "url": article URL (string)
- "summary": 2-3 sentence summary (string, escape all quotes as \")

${articlesText}

Output valid JSON only:`;

    try {
      const response = await this.client.chat.completions.create({
        model: LLM_MODEL,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.2,
        max_tokens: 200 * articles.length // Scale tokens based on number of articles
      });

      const content = response.choices[0].message.content?.trim();
      if (!content) {
        throw new Error('Empty response from AI');
      }

      // Strip markdown code blocks if present (```json ... ```)
      let jsonContent = content;
      if (content.startsWith('```')) {
        // Remove opening ```json or ``` and closing ```
        jsonContent = content
          .replace(/^```(?:json)?\s*\n?/, '')
          .replace(/\n?```\s*$/, '')
          .trim();
      }

      // Parse the JSON response
      let summaries: Array<{ url: string; summary: string }>;
      try {
        summaries = JSON.parse(jsonContent);
      } catch (parseError) {
        // Log first 500 chars for debugging
        console.error('JSON parse failed. First 500 chars:', jsonContent.substring(0, 500));
        throw new Error(`JSON parsing failed: ${parseError instanceof Error ? parseError.message : 'Unknown error'}`);
      }

      // Create a map for easy lookup
      const summaryMap = new Map<string, string>();
      for (const { url, summary } of summaries) {
        summaryMap.set(url, summary);
      }

      // Fill in fallbacks for any missing summaries
      for (const article of articles) {
        if (!summaryMap.has(article.url)) {
          summaryMap.set(article.url, article.content.substring(0, 300) + '...');
        }
      }

      return summaryMap;
    } catch (error) {
      console.error('Failed to generate batch summaries:', error);

      // Fallback: return truncated content for all articles
      const fallbackMap = new Map<string, string>();
      for (const article of articles) {
        fallbackMap.set(article.url, article.content.substring(0, 300) + '...');
      }
      return fallbackMap;
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
