import { StateGraph, END, START, Annotation } from '@langchain/langgraph';
import { ChatOpenAI } from '@langchain/openai';
import { RetrievalOutput, ValidationOutput, FinalResponse } from '../schemas';
import { AnalysisOutput, ProgressCallback, TokenStreamCallback } from './analysis';
import { detectIntent, QueryIntent } from '../search/intent-detector';
import { debugLogger } from '../utils/debug-logger';
import {
  ClaimMatch,
  NewSource,
  extractUncitedClaims,
  findEvidenceForClaims,
  injectCitations,
} from '../search/claim-evidence-finder';
import { createOpenRouterEmbeddings } from './llm';

/**
 * Define the state for the multi-agent workflow
 */
const AgentState = Annotation.Root({
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
   * Node: Intent Router
   * Detects query intent and routes to appropriate agent
   * Uses LLM for accurate classification when available
   */
  async function intentRouterNode(state: AgentStateType): Promise<Partial<AgentStateType>> {
    debugLogger.info('SUPERVISOR', 'Detecting query intent', { question: state.question });

    // Use LLM-based detection if available, otherwise fall back to fast detection
    const intentResult = intentLLM
      ? await detectIntent(state.question, intentLLM)
      : (await import('../search/intent-detector')).detectIntentFast(state.question);

    debugLogger.info('SUPERVISOR', 'Intent detected', {
      intent: intentResult.intent,
      confidence: intentResult.confidence,
      reasoning: intentResult.reasoning,
      timeframeDays: intentResult.timeframeDays,
    });

    return {
      intent: intentResult.intent,
      timeframeDays: intentResult.timeframeDays || 7,
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
   */
  async function finalizeNode(state: AgentStateType): Promise<Partial<AgentStateType>> {
    debugLogger.info('SUPERVISOR', 'Executing finalize node', {
      confidence: state.validationOutput?.confidence,
    });

    if (!state.retrievalOutput || !state.validationOutput) {
      throw new Error('Missing retrieval or validation output');
    }

    const finalAnswer = state.retrievalOutput.summary;

    return {
      finalAnswer,
    };
  }

  /**
   * Node: Finalize Analysis
   * Prepares the final response for analysis path
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
    const { summary, sentiment, trends, disclaimer } = state.analysisOutput;
    const trendList = trends.length > 0 ? `\n\nKey trends: ${trends.join(', ')}` : '';
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

    const finalAnswer = `${summary}${sentimentInfo}${trendList}${validationInfo}\n\n${disclaimer}`;

    return {
      finalAnswer,
    };
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
   */
  const workflow = new StateGraph(AgentState)
    // Add nodes
    .addNode('intentRouter', intentRouterNode)
    .addNode('retrieval', retrievalNode)
    .addNode('validation', validationNode)
    .addNode('finalize', finalizeNode)
    .addNode('analysis', analysisNode)
    .addNode('analysisValidation', analysisValidationNode)
    .addNode('findClaimEvidence', findClaimEvidenceNode)  // Smart citation recovery
    .addNode('finalizeAnalysis', finalizeAnalysisNode)

    // Define edges
    .addEdge(START, 'intentRouter')
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

  const compiledGraph = workflow.compile();

  debugLogger.stepFinish(stepId, { nodes: 8, edges: 10 });

  /**
   * Invoke the supervisor with a question
   */
  return async (question: string, onProgress?: ProgressCallback, onToken?: TokenStreamCallback): Promise<FinalResponse> => {
    const execStepId = debugLogger.stepStart('SUPERVISOR_EXEC', 'Executing supervisor workflow', {
      question,
    });

    // Set the callbacks for this execution
    currentProgressCallback = onProgress;
    currentTokenCallback = onToken;

    try {
      // Initialize state
      const initialState: AgentStateType = {
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
      };

      // Execute the workflow
      const result = await compiledGraph.invoke(initialState);

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
