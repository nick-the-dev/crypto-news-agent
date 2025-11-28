import { ChatPromptTemplate } from '@langchain/core/prompts';
import { ChatOpenAI } from '@langchain/openai';
import { DynamicStructuredTool } from '@langchain/core/tools';
import { RunnableSequence } from '@langchain/core/runnables';
import { CallbackHandler } from '@langfuse/langchain';
import { RetrievalLLMOutputSchema, RetrievalLLMOutput, RetrievalOutput } from '../schemas';
import { debugLogger } from '../utils/debug-logger';

const RETRIEVAL_SYSTEM_PROMPT = `You are a crypto news specialist. Your job is to search for and cite relevant crypto news articles.

IMPORTANT: You MUST call the search_crypto_news tool with the user's question as the "query" parameter. Example:
- User asks "What's happening with Bitcoin?" → Call search_crypto_news(query: "What's happening with Bitcoin?")

Date: {currentDate}

Rules:
- Always call search_crypto_news with the user's question as the query
- Cite every fact with [Source N]
- Only use info from sources
- Never infer or fabricate`;

const RETRIEVAL_USER_PROMPT = `{question}`;

/**
 * Create retrieval agent that searches for news and generates summaries with citations
 */
export async function createRetrievalAgent(
  llm: ChatOpenAI,
  searchTool: DynamicStructuredTool,
  langfuseHandler?: CallbackHandler
): Promise<(question: string) => Promise<RetrievalOutput>> {
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
      const callbacks = langfuseHandler ? [langfuseHandler] : [];

      // Create a chain that properly propagates callbacks
      const chain = prompt.pipe(llm.bindTools([searchTool]));

      // Step 1: Invoke chain with tools - callbacks propagate through pipe
      const response = await chain.invoke(
        {
          question,
          currentDate,
        },
        {
          callbacks,
          runName: 'Retrieval: Search News',
        }
      );

      debugLogger.info('AGENT_RETRIEVAL', 'LLM responded', {
        hasToolCalls: (response.additional_kwargs.tool_calls?.length ?? 0) > 0,
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
          retrievalMetrics: searchResults?.retrievalMetrics,
        };
        debugLogger.stepFinish(stepId, fallbackOutput);
        return fallbackOutput;
      }

      // CRITICAL: If confidence is low/none, return immediately WITHOUT calling LLM
      // This prevents hallucinations when sources are irrelevant
      const confidenceLevel = searchResults.confidence?.level || 'medium';
      if (confidenceLevel === 'low' || confidenceLevel === 'none') {
        debugLogger.warn('AGENT_RETRIEVAL', 'Low confidence - returning without LLM to prevent hallucination', {
          confidenceLevel,
          confidenceScore: searchResults.confidence?.score,
          articlesCount: searchResults.articles.length,
        });
        const lowConfidenceOutput: RetrievalOutput = {
          summary: `I couldn't find relevant information about this topic in recent crypto news. The search returned ${searchResults.articles.length} articles, but none were directly relevant to your question.`,
          sources: [],
          citationCount: 0,
          retrievalMetrics: searchResults.retrievalMetrics,
        };
        debugLogger.stepFinish(stepId, lowConfidenceOutput);
        return lowConfidenceOutput;
      }

      // Step 3: Generate summary with structured output
      // CRITICAL: Use RunnableSequence for proper LangFuse sessionId tracking
      // Direct llm.invoke() does NOT trigger handleChainStart, causing orphaned traces with NULL sessionId
      // Use RetrievalLLMOutputSchema (without retrievalMetrics) to avoid LLM output truncation
      const summaryLLM = llm.withStructuredOutput<RetrievalLLMOutput>(RetrievalLLMOutputSchema);

      // At this point, confidence is medium or high (low/none returned early above)
      const sourcesText = searchResults.articles.map((a: any) => `[Source ${a.sourceNumber}] ${a.title} (${a.publishedAt}): ${a.quote}`).join('\n\n');

      const summaryPromptTemplate = ChatPromptTemplate.fromTemplate(
        `Answer "{question}" in 2-3 sentences using only these sources. Cite every fact with [Source N].

{sourcesText}`
      );

      const summaryChain = RunnableSequence.from([
        summaryPromptTemplate,
        summaryLLM,
      ]);

      const summaryResponse = await summaryChain.invoke(
        {
          question,
          sourcesText,
        },
        {
          callbacks,
          runName: 'Retrieval: Generate Summary',
        }
      );

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
        retrievalMetrics: searchResults.retrievalMetrics,
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
