import { StateGraph, END, START, Annotation } from '@langchain/langgraph';
import { ChatOpenAI } from '@langchain/openai';
import { RetrievalOutput, ValidationOutput, FinalResponse } from '../schemas';
import { AnalysisOutput, ProgressCallback, TokenStreamCallback } from './analysis';
import { detectIntent, QueryIntent } from '../search/intent-detector';
import { debugLogger } from '../utils/debug-logger';

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
    debugLogger.info('SUPERVISOR', 'Executing finalize analysis node');

    if (!state.analysisOutput) {
      throw new Error('Missing analysis output');
    }

    // Format analysis output as final answer
    const { summary, sentiment, trends, disclaimer } = state.analysisOutput;
    const trendList = trends.length > 0 ? `\n\nKey trends: ${trends.join(', ')}` : '';
    const sentimentInfo = `\n\nMarket sentiment: ${sentiment.overall} (${sentiment.bullishPercent}% bullish, ${sentiment.bearishPercent}% bearish)`;

    const finalAnswer = `${summary}${sentimentInfo}${trendList}\n\n${disclaimer}`;

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
   * Build the state graph
   */
  const workflow = new StateGraph(AgentState)
    // Add nodes
    .addNode('intentRouter', intentRouterNode)
    .addNode('retrieval', retrievalNode)
    .addNode('validation', validationNode)
    .addNode('finalize', finalizeNode)
    .addNode('analysis', analysisNode)
    .addNode('finalizeAnalysis', finalizeAnalysisNode)

    // Define edges
    .addEdge(START, 'intentRouter')
    .addConditionalEdges('intentRouter', routeByIntent, {
      retrieval: 'retrieval',
      analysis: 'analysis',
    })
    .addEdge('retrieval', 'validation')
    .addConditionalEdges('validation', shouldRetry, {
      retrieval: 'retrieval',
      finalize: 'finalize',
    })
    .addEdge('finalize', END)
    .addEdge('analysis', 'finalizeAnalysis')
    .addEdge('finalizeAnalysis', END);

  const compiledGraph = workflow.compile();

  debugLogger.stepFinish(stepId, { nodes: 6, edges: 7 });

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

        const finalResponse: FinalResponse = {
          answer: result.finalAnswer,
          sources: sources,
          confidence: result.analysisOutput.confidence,
          validated: true,
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
          confidence: result.analysisOutput.confidence,
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
