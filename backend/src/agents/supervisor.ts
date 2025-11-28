import { StateGraph, END, START, Annotation, MemorySaver, messagesStateReducer } from '@langchain/langgraph';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { ChatOpenAI } from '@langchain/openai';
import { BaseMessage, HumanMessage, AIMessage } from '@langchain/core/messages';
import { ChatPromptTemplate } from '@langchain/core/prompts';
import { RetrievalOutput, ValidationOutput, FinalResponse, Source } from '../schemas';
import { AnalysisOutput, ProgressCallback, TokenStreamCallback } from './analysis';
import { detectIntent, QueryIntent } from '../search/intent-detector';
import { detectFollowup, FollowupType, FollowupResult } from '../search/followup-detector';
import { getConversationContext, ConversationContext } from '../utils/conversation-store';
import { debugLogger } from '../utils/debug-logger';
import {
  ClaimMatch,
  NewSource,
  extractUncitedClaims,
  findEvidenceForClaims,
  injectCitations,
} from '../search/claim-evidence-finder';
import { createOpenRouterEmbeddings } from './llm';

// Initialize PostgreSQL checkpointer for persistent conversation memory
let checkpointer: PostgresSaver | MemorySaver = new MemorySaver();
let checkpointerInitialized = false;

async function initializeCheckpointer(): Promise<PostgresSaver | MemorySaver> {
  if (checkpointerInitialized) {
    return checkpointer;
  }

  try {
    const dbUrl = process.env.DATABASE_URL;
    if (dbUrl) {
      const pgSaver = PostgresSaver.fromConnString(dbUrl);
      // Create the checkpoint tables if they don't exist
      await pgSaver.setup();
      checkpointer = pgSaver;
      debugLogger.info('SUPERVISOR', 'PostgresSaver initialized with checkpoint tables');
    } else {
      debugLogger.warn('SUPERVISOR', 'DATABASE_URL not set, using MemorySaver (non-persistent)');
    }
  } catch (error) {
    debugLogger.warn('SUPERVISOR', 'Failed to initialize PostgresSaver, using MemorySaver', { error });
  }

  checkpointerInitialized = true;
  return checkpointer;
}

/**
 * Define the state for the multi-agent workflow
 * Includes messages for conversation memory (chat-like behavior)
 */
const AgentState = Annotation.Root({
  // Conversation history for chat-like behavior
  messages: Annotation<BaseMessage[]>({
    reducer: messagesStateReducer,
    default: () => [],
  }),
  question: Annotation<string>,
  intent: Annotation<QueryIntent>,
  timeframeDays: Annotation<number>,
  retrievalOutput: Annotation<RetrievalOutput | null>,
  validationOutput: Annotation<ValidationOutput | null>,
  analysisOutput: Annotation<AnalysisOutput | null>,
  finalAnswer: Annotation<string | null>,
  retryCount: Annotation<number>,
  // Smart citation recovery state
  analysisRetryCount: Annotation<number>,
  claimMatches: Annotation<ClaimMatch[] | null>,
  // Follow-up detection state
  followupType: Annotation<FollowupType | null>,
  followupResult: Annotation<FollowupResult | null>,
  conversationContext: Annotation<ConversationContext | null>,
});

type AgentStateType = typeof AgentState.State;

/**
 * Create the multi-agent supervisor using LangGraph
 */
export function createSupervisor(
  retrievalAgent: (question: string) => Promise<RetrievalOutput>,
  validationAgent: (retrievalOutput: RetrievalOutput) => Promise<ValidationOutput>,
  analysisAgent?: (question: string, daysBack: number, onProgress?: ProgressCallback, onToken?: TokenStreamCallback) => Promise<AnalysisOutput>,
  intentLLM?: ChatOpenAI
) {
  const stepId = debugLogger.stepStart('SUPERVISOR_INIT', 'Initializing LangGraph supervisor');

  // Mutable references to hold callbacks (set when supervisor is invoked)
  let currentProgressCallback: ProgressCallback | undefined;
  let currentTokenCallback: TokenStreamCallback | undefined;

  /**
   * Node: Follow-up Router
   * Detects if the message is a follow-up (clarification/refinement) or new query
   * This runs first to determine how to handle the message
   */
  async function followupRouterNode(state: AgentStateType): Promise<Partial<AgentStateType>> {
    const threadId = state.conversationContext?.threadId;
    debugLogger.info('SUPERVISOR', 'Detecting follow-up type', {
      question: state.question,
      hasContext: !!state.conversationContext,
      historyLength: state.conversationContext?.turns.length ?? 0,
    });

    // Get conversation context from database if we have a threadId
    let context = state.conversationContext;
    if (threadId && (!context || context.turns.length === 0)) {
      context = await getConversationContext(threadId);
      debugLogger.info('SUPERVISOR', 'Loaded conversation context from database', {
        threadId,
        turnsLoaded: context.turns.length,
      });
    }

    // If no context, this is definitely a new query
    if (!context || context.turns.length === 0) {
      debugLogger.info('SUPERVISOR', 'No conversation history, treating as new query');
      return {
        followupType: 'new_query',
        followupResult: {
          type: 'new_query',
          confidence: 1.0,
          reasoning: 'First message in conversation',
        },
        conversationContext: context,
      };
    }

    // Detect follow-up type using the LLM if available
    const followupResult = await detectFollowup(state.question, context, intentLLM);

    debugLogger.info('SUPERVISOR', 'Follow-up type detected', {
      type: followupResult.type,
      confidence: followupResult.confidence,
      reasoning: followupResult.reasoning,
      refinedQuery: followupResult.refinedQuery,
    });

    return {
      followupType: followupResult.type,
      followupResult,
      conversationContext: context,
    };
  }

  /**
   * Node: Clarification
   * Handles clarification requests by generating a response from conversation context
   * No new search needed - uses previous answer and sources
   */
  async function clarificationNode(state: AgentStateType): Promise<Partial<AgentStateType>> {
    debugLogger.info('SUPERVISOR', 'Handling clarification request', {
      question: state.question,
      hasContext: !!state.conversationContext,
    });

    if (!state.conversationContext || state.conversationContext.turns.length === 0) {
      throw new Error('No conversation context available for clarification');
    }

    // Get the last assistant turn for sources
    const lastAssistantTurn = [...state.conversationContext.turns]
      .reverse()
      .find(t => t.role === 'assistant');

    const sources = lastAssistantTurn?.sources || [];

    // Build context from conversation history
    const historyContext = state.conversationContext.turns
      .slice(-4) // Last 4 turns (2 exchanges)
      .map(t => `${t.role.toUpperCase()}: ${t.content}`)
      .join('\n\n');

    // Use LLM to generate clarification response
    const clarificationLLM = intentLLM || new ChatOpenAI({
      modelName: 'gpt-4o-mini',
      temperature: 0.3,
    });

    const clarificationPrompt = ChatPromptTemplate.fromMessages([
      ['system', `You are a helpful crypto news assistant. The user is asking for clarification about your previous response.

Based on the conversation history, answer their clarification question. Be concise and helpful.
If they're asking "are you sure?" or similar, explain your confidence and cite specific sources.
If they're asking "why?" or "how?", provide more detail from the context.

Use [Source N] citations when referencing information. Only use sources from the previous response.`],
      ['human', `CONVERSATION HISTORY:
{history}

USER'S CLARIFICATION QUESTION: {question}

Provide a helpful clarification response:`],
    ]);

    const chain = clarificationPrompt.pipe(clarificationLLM);
    const response = await chain.invoke({
      history: historyContext,
      question: state.question,
    });

    const clarificationAnswer = typeof response.content === 'string'
      ? response.content
      : JSON.stringify(response.content);

    debugLogger.info('SUPERVISOR', 'Clarification response generated', {
      answerLength: clarificationAnswer.length,
      sourcesCount: sources.length,
    });

    // Return as final answer with existing sources
    return {
      finalAnswer: clarificationAnswer,
      retrievalOutput: {
        summary: clarificationAnswer,
        sources: sources.map(s => ({
          title: s.title,
          url: s.url,
          publishedAt: s.publishedAt,
          quote: s.quote || '',
          relevance: s.relevance || 0,
        })),
        citationCount: sources.length,
      },
      validationOutput: {
        isValid: true,
        confidence: 90, // High confidence for clarifications using existing sources
        citationsVerified: sources.length,
        citationsTotal: sources.length,
        issues: [],
      },
      messages: [new AIMessage(clarificationAnswer)],
    };
  }

  /**
   * Node: Intent Router
   * Detects query intent and routes to appropriate agent
   * Uses LLM for accurate classification when available
   */
  async function intentRouterNode(state: AgentStateType): Promise<Partial<AgentStateType>> {
    // If this is a refinement, use the refined query
    let queryToAnalyze = state.followupResult?.refinedQuery || state.question;

    // SAFEGUARD: If this is a refinement but no refinedQuery was generated,
    // try to extract the original topic from conversation history
    if (
      state.followupResult?.type === 'refinement' &&
      !state.followupResult?.refinedQuery &&
      state.conversationContext?.turns.length
    ) {
      // Find the first user message (usually contains the original topic)
      const firstUserTurn = state.conversationContext.turns.find(t => t.role === 'user');
      if (firstUserTurn) {
        // Extract crypto keywords from the original question
        const cryptoKeywords = firstUserTurn.content.match(/\b(bitcoin|btc|ethereum|eth|solana|sol|defi|nft|crypto|altcoin|memecoin|doge|shib|xrp|cardano|ada|polygon|matic|avalanche|avax|chainlink|link)\b/gi);
        if (cryptoKeywords && cryptoKeywords.length > 0) {
          // Prepend the topic to the current question
          const topic = [...new Set(cryptoKeywords.map(k => k.toUpperCase()))].join(', ');
          queryToAnalyze = `${state.question} about ${topic}`;
          debugLogger.info('SUPERVISOR', 'Enriched query with topic from history', {
            originalQuery: state.question,
            extractedTopic: topic,
            enrichedQuery: queryToAnalyze,
          });
        }
      }
    }

    debugLogger.info('SUPERVISOR', 'Detecting query intent', {
      question: state.question,
      refinedQuery: state.followupResult?.refinedQuery,
      queryToAnalyze,
    });

    // Use LLM-based detection if available, otherwise fall back to fast detection
    const intentResult = intentLLM
      ? await detectIntent(queryToAnalyze, intentLLM)
      : (await import('../search/intent-detector')).detectIntentFast(queryToAnalyze);

    debugLogger.info('SUPERVISOR', 'Intent detected', {
      intent: intentResult.intent,
      confidence: intentResult.confidence,
      reasoning: intentResult.reasoning,
      timeframeDays: intentResult.timeframeDays,
    });

    // Update the question if we have a refined query
    return {
      intent: intentResult.intent,
      timeframeDays: intentResult.timeframeDays || 7,
      question: queryToAnalyze, // Use refined query for downstream processing
    };
  }

  /**
   * Node: Retrieval
   * Executes the retrieval agent to search and summarize news
   */
  async function retrievalNode(state: AgentStateType): Promise<Partial<AgentStateType>> {
    debugLogger.info('SUPERVISOR', 'Executing retrieval node', {
      question: state.question,
      retryCount: state.retryCount,
    });

    const retrievalOutput = await retrievalAgent(state.question);

    return {
      retrievalOutput,
    };
  }

  /**
   * Node: Analysis
   * Executes the analysis agent for analytical queries
   */
  async function analysisNode(state: AgentStateType): Promise<Partial<AgentStateType>> {
    if (!analysisAgent) {
      throw new Error('Analysis agent not configured');
    }

    debugLogger.info('SUPERVISOR', 'Executing analysis node', {
      question: state.question,
      timeframeDays: state.timeframeDays,
    });

    // Pass the progress and token callbacks to the analysis agent
    const output = await analysisAgent(state.question, state.timeframeDays, currentProgressCallback, currentTokenCallback);

    return {
      analysisOutput: output,
    };
  }

  /**
   * Node: Analysis Validation
   * Validates the analysis output by converting it to RetrievalOutput format
   * and reusing the existing validation agent
   */
  async function analysisValidationNode(state: AgentStateType): Promise<Partial<AgentStateType>> {
    debugLogger.info('SUPERVISOR', 'Executing analysis validation node');

    if (!state.analysisOutput) {
      throw new Error('No analysis output available for validation');
    }

    // Convert AnalysisOutput to RetrievalOutput format for validation
    // The validation agent expects sources and a summary with [Source N] citations
    const retrievalOutput: RetrievalOutput = {
      summary: state.analysisOutput.summary,
      sources: state.analysisOutput.topSources.map((source) => ({
        title: source.title,
        url: source.url,
        publishedAt: source.publishedAt,
        quote: source.quote,
        relevance: source.relevance ?? 0,
      })),
      citationCount: state.analysisOutput.citationCount,
    };

    debugLogger.info('SUPERVISOR', 'Converted analysis to retrieval format for validation', {
      sourcesCount: retrievalOutput.sources.length,
      citationCount: retrievalOutput.citationCount,
    });

    // Reuse the existing validation agent
    const validationOutput = await validationAgent(retrievalOutput);

    debugLogger.info('SUPERVISOR', 'Analysis validation complete', {
      confidence: validationOutput.confidence,
      isValid: validationOutput.isValid,
      citationsVerified: validationOutput.citationsVerified,
      citationsTotal: validationOutput.citationsTotal,
    });

    return {
      validationOutput,
    };
  }

  /**
   * Node: Find Claim Evidence
   * Searches vector DB in parallel for evidence to support uncited claims
   * Only runs when analysis validation fails (isValid: false)
   */
  async function findClaimEvidenceNode(state: AgentStateType): Promise<Partial<AgentStateType>> {
    debugLogger.info('SUPERVISOR', 'Finding evidence for uncited claims');

    if (!state.analysisOutput) {
      throw new Error('No analysis output available for evidence search');
    }

    // Extract uncited sentences
    const uncitedClaims = extractUncitedClaims(state.analysisOutput.summary);

    if (uncitedClaims.length === 0) {
      debugLogger.info('SUPERVISOR', 'No uncited claims found');
      return {
        claimMatches: [],
        analysisRetryCount: 1,
      };
    }

    debugLogger.info('SUPERVISOR', 'Searching for evidence', {
      uncitedClaimsCount: uncitedClaims.length,
      existingSourcesCount: state.analysisOutput.topSources.length,
    });

    // Create embeddings instance for search
    const embeddings = createOpenRouterEmbeddings();

    // Parallel vector search for all claims
    const claimMatches = await findEvidenceForClaims(
      uncitedClaims,
      embeddings,
      state.analysisOutput.topSources,
      { daysBack: state.timeframeDays, minSimilarity: 0.45 }
    );

    // Inject citations into the summary (now also returns new sources)
    const { updatedSummary, citationsAdded, newSources } = injectCitations(
      state.analysisOutput.summary,
      claimMatches,
      state.analysisOutput.topSources.length
    );

    // Merge new sources into topSources
    const updatedTopSources = [...state.analysisOutput.topSources, ...newSources];

    debugLogger.info('SUPERVISOR', 'Evidence search complete', {
      claimsSearched: uncitedClaims.length,
      existingSourceMatches: claimMatches.filter(m => m.sourceIndex > 0).length,
      newSourcesAdded: newSources.length,
      citationsAdded,
      totalSources: updatedTopSources.length,
    });

    return {
      analysisOutput: {
        ...state.analysisOutput,
        summary: updatedSummary,
        topSources: updatedTopSources,
      },
      claimMatches,
      analysisRetryCount: 1,
    };
  }

  /**
   * Node: Validation
   * Validates the retrieval output for citation accuracy
   */
  async function validationNode(state: AgentStateType): Promise<Partial<AgentStateType>> {
    debugLogger.info('SUPERVISOR', 'Executing validation node');

    if (!state.retrievalOutput) {
      throw new Error('No retrieval output available for validation');
    }

    const validationOutput = await validationAgent(state.retrievalOutput);

    // Increment retry count if we're going to retry (checked in shouldRetry)
    const willRetry = validationOutput.confidence < 70 && state.retryCount < 1;

    return {
      validationOutput,
      retryCount: willRetry ? state.retryCount + 1 : state.retryCount,
    };
  }

  /**
   * Node: Finalize
   * Prepares the final response for retrieval path
   * Adds the AI response to conversation history for memory persistence
   */
  async function finalizeNode(state: AgentStateType): Promise<Partial<AgentStateType>> {
    debugLogger.info('SUPERVISOR', 'Executing finalize node', {
      confidence: state.validationOutput?.confidence,
    });

    if (!state.retrievalOutput || !state.validationOutput) {
      throw new Error('Missing retrieval or validation output');
    }

    const finalAnswer = state.retrievalOutput.summary;

    // Add the AI response to conversation history
    return {
      finalAnswer,
      messages: [new AIMessage(finalAnswer)],
    };
  }

  /**
   * Node: Finalize Analysis
   * Prepares the final response for analysis path
   * Adds the AI response to conversation history for memory persistence
   */
  async function finalizeAnalysisNode(state: AgentStateType): Promise<Partial<AgentStateType>> {
    debugLogger.info('SUPERVISOR', 'Executing finalize analysis node', {
      hasValidationOutput: !!state.validationOutput,
      validationConfidence: state.validationOutput?.confidence,
      validationIsValid: state.validationOutput?.isValid,
      hasClaimMatches: !!state.claimMatches,
      claimMatchesCount: state.claimMatches?.length ?? 0,
    });

    if (!state.analysisOutput) {
      throw new Error('Missing analysis output');
    }

    // Format analysis output as final answer
    const { summary, sentiment, articlesAnalyzed } = state.analysisOutput;
    const sentimentInfo = `\n\nMarket sentiment: ${sentiment.overall} (${sentiment.bullishPercent}% bullish, ${sentiment.bearishPercent}% bearish)`;

    // Add evidence search info if we ran smart citation recovery
    const claimMatches = state.claimMatches ?? [];
    const evidenceSearched = claimMatches.length > 0;
    const evidenceFound = claimMatches.filter(m => m.sourceIndex > 0).length;
    const evidenceInfo = evidenceSearched
      ? ` (${evidenceFound} claims verified via search)`
      : '';

    // Add validation status if available
    const validationInfo = state.validationOutput
      ? `\n\n📊 Citation Quality${evidenceInfo}: ${state.validationOutput.citationsVerified}/${state.validationOutput.citationsTotal} citations verified (${state.validationOutput.confidence}% confidence)`
      : '';

    // Add articles analyzed count
    const articlesInfo = `\n\n📰 Based on ${articlesAnalyzed} articles analyzed`;

    const finalAnswer = `${summary}${sentimentInfo}${articlesInfo}${validationInfo}`;

    // Add the AI response to conversation history
    return {
      finalAnswer,
      messages: [new AIMessage(finalAnswer)],
    };
  }

  /**
   * Conditional edge: Route based on follow-up type
   * - clarification: go to clarification node (no search)
   * - refinement/new_query: go to intent router (then search)
   */
  function routeByFollowup(state: AgentStateType): string {
    const followupType = state.followupType || 'new_query';

    debugLogger.info('SUPERVISOR', 'Routing by follow-up type', { followupType });

    if (followupType === 'clarification') {
      return 'clarification';
    }

    // Both 'new_query' and 'refinement' go through intent detection
    return 'intentRouter';
  }

  /**
   * Conditional edge: Route based on query intent
   */
  function routeByIntent(state: AgentStateType): string {
    const { intent } = state;

    debugLogger.info('SUPERVISOR', 'Routing by intent', { intent });

    if (intent === 'analysis' && analysisAgent) {
      return 'analysis';
    }

    return 'retrieval';
  }

  /**
   * Conditional edge: Route based on validation confidence
   */
  function shouldRetry(state: AgentStateType): string {
    if (!state.validationOutput) {
      return 'finalize';
    }

    const { confidence } = state.validationOutput;
    const { retryCount } = state;

    debugLogger.info('SUPERVISOR', 'Checking retry condition', {
      confidence,
      retryCount,
      threshold: 70,
    });

    // Retry if confidence < 70 and we haven't retried yet
    if (confidence < 70 && retryCount < 1) {
      debugLogger.warn('SUPERVISOR', 'Low confidence, triggering retry', {
        confidence,
        retryCount,
      });
      return 'retrieval';
    }

    return 'finalize';
  }

  /**
   * Conditional edge: Route analysis validation to evidence search or finalize
   */
  function shouldRefineAnalysis(state: AgentStateType): string {
    if (!state.validationOutput) {
      return 'finalizeAnalysis';
    }

    const { isValid } = state.validationOutput;
    const hasRetried = (state.analysisRetryCount ?? 0) > 0;

    debugLogger.info('SUPERVISOR', 'Checking analysis refinement condition', {
      isValid,
      hasRetried,
      analysisRetryCount: state.analysisRetryCount ?? 0,
    });

    // Only try evidence search once, and only if validation failed
    if (!isValid && !hasRetried) {
      debugLogger.info('SUPERVISOR', 'Validation failed, triggering evidence search');
      return 'findEvidence';
    }

    return 'finalizeAnalysis';
  }

  /**
   * Build the state graph
   *
   * Flow:
   * START → followupRouter → [clarification | intentRouter]
   *   ├─ clarification → finalize → END
   *   └─ intentRouter → [retrieval | analysis]
   *        ├─ retrieval → validation → [retry | finalize] → END
   *        └─ analysis → analysisValidation → [findEvidence | finalizeAnalysis] → END
   */
  const workflow = new StateGraph(AgentState)
    // Add nodes
    .addNode('followupRouter', followupRouterNode)
    .addNode('clarification', clarificationNode)
    .addNode('intentRouter', intentRouterNode)
    .addNode('retrieval', retrievalNode)
    .addNode('validation', validationNode)
    .addNode('finalize', finalizeNode)
    .addNode('analysis', analysisNode)
    .addNode('analysisValidation', analysisValidationNode)
    .addNode('findClaimEvidence', findClaimEvidenceNode)  // Smart citation recovery
    .addNode('finalizeAnalysis', finalizeAnalysisNode)

    // Define edges
    // Entry point: follow-up detection
    .addEdge(START, 'followupRouter')
    .addConditionalEdges('followupRouter', routeByFollowup, {
      clarification: 'clarification',
      intentRouter: 'intentRouter',
    })
    // Clarification path goes directly to finalize
    .addEdge('clarification', 'finalize')
    // Intent router routes to retrieval or analysis
    .addConditionalEdges('intentRouter', routeByIntent, {
      retrieval: 'retrieval',
      analysis: 'analysis',
    })
    // Retrieval path: retrieval → validation → finalize
    .addEdge('retrieval', 'validation')
    .addConditionalEdges('validation', shouldRetry, {
      retrieval: 'retrieval',
      finalize: 'finalize',
    })
    .addEdge('finalize', END)
    // Analysis path with smart citation recovery:
    // analysis → analysisValidation → [isValid?]
    //   ├─ YES → finalizeAnalysis → END
    //   └─ NO → findClaimEvidence → analysisValidation → finalizeAnalysis → END
    .addEdge('analysis', 'analysisValidation')
    .addConditionalEdges('analysisValidation', shouldRefineAnalysis, {
      findEvidence: 'findClaimEvidence',
      finalizeAnalysis: 'finalizeAnalysis',
    })
    .addEdge('findClaimEvidence', 'analysisValidation')  // Re-validate after evidence search
    .addEdge('finalizeAnalysis', END);

  // Lazy-compiled graph (initialized on first invoke)
  let compiledGraph: ReturnType<typeof workflow.compile> | null = null;

  debugLogger.stepFinish(stepId, { nodes: 10, edges: 12 });

  /**
   * Invoke the supervisor with a question
   * @param question - The user's question
   * @param onProgress - Optional progress callback for streaming
   * @param onToken - Optional token callback for streaming
   * @param threadId - Optional thread ID for conversation memory (chat-like behavior)
   */
  return async (
    question: string,
    onProgress?: ProgressCallback,
    onToken?: TokenStreamCallback,
    threadId?: string
  ): Promise<FinalResponse> => {
    const execStepId = debugLogger.stepStart('SUPERVISOR_EXEC', 'Executing supervisor workflow', {
      question,
      threadId: threadId ?? 'new-session',
    });

    // Set the callbacks for this execution
    currentProgressCallback = onProgress;
    currentTokenCallback = onToken;

    try {
      // Lazy-initialize checkpointer and compile graph on first invoke
      if (!compiledGraph) {
        const activeCheckpointer = await initializeCheckpointer();
        compiledGraph = workflow.compile({ checkpointer: activeCheckpointer });
        debugLogger.info('SUPERVISOR', 'Workflow compiled with checkpointer');
      }

      // Create config with thread_id for conversation memory
      const config = threadId
        ? { configurable: { thread_id: threadId } }
        : undefined;

      // Initialize state with the user's message in conversation history
      const initialState: Partial<AgentStateType> = {
        messages: [new HumanMessage(question)],
        question,
        intent: 'retrieval',
        timeframeDays: 7,
        retrievalOutput: null,
        validationOutput: null,
        analysisOutput: null,
        finalAnswer: null,
        retryCount: 0,
        // Smart citation recovery
        analysisRetryCount: 0,
        claimMatches: null,
        // Follow-up detection - pass threadId so followupRouter can load context
        followupType: null,
        followupResult: null,
        conversationContext: threadId ? { threadId, turns: [] } : null,
      };

      // Execute the workflow with config for memory persistence
      const result = await compiledGraph.invoke(initialState, config);

      if (!result.finalAnswer) {
        throw new Error('Workflow did not complete successfully');
      }

      // Handle analysis path
      if (result.intent === 'analysis' && result.analysisOutput) {
        // Convert analysis topSources to FinalResponse source format
        const sources = result.analysisOutput.topSources || [];

        // Use validation confidence if available, otherwise use analysis confidence
        const confidence = result.validationOutput?.confidence ?? result.analysisOutput.confidence;
        const validated = result.validationOutput?.isValid ?? true;

        const finalResponse: FinalResponse = {
          answer: result.finalAnswer,
          sources: sources,
          confidence,
          validated,
          metadata: {
            retriesUsed: 0,
            timestamp: new Date().toISOString(),
          },
        };

        debugLogger.stepFinish(execStepId, {
          intent: 'analysis',
          articlesAnalyzed: result.analysisOutput.articlesAnalyzed,
          cachedInsights: result.analysisOutput.cachedInsights,
          newInsights: result.analysisOutput.newInsights,
          sentiment: result.analysisOutput.sentiment.overall,
          analysisConfidence: result.analysisOutput.confidence,
          validationConfidence: result.validationOutput?.confidence,
          citationsVerified: result.validationOutput?.citationsVerified,
          citationsTotal: result.validationOutput?.citationsTotal,
          validated,
          sourcesCount: sources.length,
        });

        return finalResponse;
      }

      // Handle retrieval path
      if (!result.retrievalOutput || !result.validationOutput) {
        throw new Error('Missing retrieval or validation output');
      }

      const finalResponse: FinalResponse = {
        answer: result.finalAnswer,
        sources: result.retrievalOutput.sources,
        confidence: result.validationOutput.confidence,
        validated: result.validationOutput.isValid,
        metadata: {
          retriesUsed: result.retryCount,
          timestamp: new Date().toISOString(),
        },
      };

      debugLogger.stepFinish(execStepId, {
        intent: 'retrieval',
        confidence: finalResponse.confidence,
        validated: finalResponse.validated,
        retriesUsed: finalResponse.metadata.retriesUsed,
        sourcesCount: finalResponse.sources.length,
      });

      return finalResponse;
    } catch (error) {
      debugLogger.stepError(execStepId, 'SUPERVISOR_EXEC', 'Error in supervisor execution', error);
      throw error;
    }
  };
}
