import { ChatPromptTemplate } from '@langchain/core/prompts';
import { ChatOpenAI } from '@langchain/openai';
import { DynamicStructuredTool } from '@langchain/core/tools';
import { RetrievalOutputSchema, RetrievalOutput } from '../schemas';
import { debugLogger } from '../utils/debug-logger';

const RETRIEVAL_SYSTEM_PROMPT = `You are a crypto news retrieval specialist. Your job is to:
1. Use the search_crypto_news tool to find relevant crypto news articles
2. Analyze the articles and create a comprehensive summary
3. Cite sources using the format [Source N] where N is the sourceNumber from the search results
4. Focus on factual information only

Current date: {currentDate}

IMPORTANT CITATION RULES:
- Every factual claim MUST be cited with [Source N]
- Use the exact sourceNumber from the search results
- Multiple claims from the same source should repeat the citation
- Do NOT make up or infer information not in the sources

Example:
Bitcoin reached $45,000 today [Source 1], marking a 10% increase [Source 2].`;

const RETRIEVAL_USER_PROMPT = `Question: {question}

Please search for relevant crypto news and provide a comprehensive summary with proper citations.`;

/**
 * Create retrieval agent that searches for news and generates summaries with citations
 */
export async function createRetrievalAgent(
  llm: ChatOpenAI,
  searchTool: DynamicStructuredTool
): Promise<(question: string) => Promise<RetrievalOutput>> {
  // Bind tool to LLM
  const llmWithTools = llm.bindTools([searchTool]);

  // Create prompt template
  const prompt = ChatPromptTemplate.fromMessages([
    ['system', RETRIEVAL_SYSTEM_PROMPT],
    ['human', RETRIEVAL_USER_PROMPT],
  ]);

  return async (question: string): Promise<RetrievalOutput> => {
    const stepId = debugLogger.stepStart('AGENT_RETRIEVAL', 'Retrieval agent executing', {
      question,
    });

    try {
      const currentDate = new Date().toISOString().split('T')[0];

      // Step 1: Invoke LLM with tools
      const response = await llmWithTools.invoke(
        await prompt.format({
          question,
          currentDate,
        })
      );

      debugLogger.info('AGENT_RETRIEVAL', 'LLM responded', {
        hasToolCalls: response.additional_kwargs.tool_calls?.length > 0,
      });

      // Step 2: Execute tool calls if any
      let searchResults: any = null;
      if (response.additional_kwargs.tool_calls) {
        for (const toolCall of response.additional_kwargs.tool_calls) {
          if (toolCall.function.name === 'search_crypto_news') {
            const args = JSON.parse(toolCall.function.arguments);
            debugLogger.info('AGENT_RETRIEVAL', 'Executing search_crypto_news', args);
            const result = await searchTool.invoke(args);
            searchResults = JSON.parse(result);
          }
        }
      }

      if (!searchResults || !searchResults.articles || searchResults.articles.length === 0) {
        debugLogger.warn('AGENT_RETRIEVAL', 'No articles found');
        const fallbackOutput: RetrievalOutput = {
          summary: 'No relevant crypto news articles found for this query.',
          sources: [],
          citationCount: 0,
        };
        debugLogger.stepFinish(stepId, fallbackOutput);
        return fallbackOutput;
      }

      // Step 3: Generate summary with structured output
      const summaryLLM = llm.withStructuredOutput(RetrievalOutputSchema);

      const summaryPrompt = `Based on the search results below, create a comprehensive summary with proper citations.

Search Results:
${searchResults.articles.map((a: any, i: number) => `
[Source ${a.sourceNumber}]
Title: ${a.title}
Published: ${a.publishedAt}
Quote: ${a.quote}
`).join('\n')}

Create a summary that:
1. Answers the question: "${question}"
2. Cites every fact using [Source N] format
3. Uses information only from the search results
4. Is 2-3 sentences long

Return your response as JSON with:
- summary: The summary text with [Source N] citations
- sources: Array of source objects
- citationCount: Number of citations used`;

      const summaryResponse = await summaryLLM.invoke(summaryPrompt);

      // Map search results to Source schema format
      const sources = searchResults.articles.map((a: any) => ({
        title: a.title,
        url: a.url,
        publishedAt: a.publishedAt,
        quote: a.quote,
        relevance: a.relevance,
      }));

      const output: RetrievalOutput = {
        summary: summaryResponse.summary,
        sources,
        citationCount: summaryResponse.citationCount,
      };

      debugLogger.stepFinish(stepId, {
        sourcesFound: sources.length,
        citationCount: output.citationCount,
      });

      return output;
    } catch (error) {
      debugLogger.stepError(stepId, 'AGENT_RETRIEVAL', 'Error in retrieval agent', error);
      throw error;
    }
  };
}
