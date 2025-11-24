import { StateGraph, END, START, Annotation } from '@langchain/langgraph';
import { RetrievalOutput, ValidationOutput, FinalResponse } from '../schemas';
import { debugLogger } from '../utils/debug-logger';

/**
 * Define the state for the multi-agent workflow
 */
const AgentState = Annotation.Root({
  question: Annotation<string>,
  retrievalOutput: Annotation<RetrievalOutput | null>,
  validationOutput: Annotation<ValidationOutput | null>,
  finalAnswer: Annotation<string | null>,
  retryCount: Annotation<number>,
});

type AgentStateType = typeof AgentState.State;

/**
 * Create the multi-agent supervisor using LangGraph
 */
export function createSupervisor(
  retrievalAgent: (question: string) => Promise<RetrievalOutput>,
  validationAgent: (retrievalOutput: RetrievalOutput) => Promise<ValidationOutput>
) {
  const stepId = debugLogger.stepStart('SUPERVISOR_INIT', 'Initializing LangGraph supervisor');

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
   * Node: Validation
   * Validates the retrieval output for citation accuracy
   */
  async function validationNode(state: AgentStateType): Promise<Partial<AgentStateType>> {
    debugLogger.info('SUPERVISOR', 'Executing validation node');

    if (!state.retrievalOutput) {
      throw new Error('No retrieval output available for validation');
    }

    const validationOutput = await validationAgent(state.retrievalOutput);

    return {
      validationOutput,
    };
  }

  /**
   * Node: Finalize
   * Prepares the final response
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
    .addNode('retrieval', retrievalNode)
    .addNode('validation', validationNode)
    .addNode('finalize', finalizeNode)

    // Define edges
    .addEdge(START, 'retrieval')
    .addEdge('retrieval', 'validation')
    .addConditionalEdges('validation', shouldRetry, {
      retrieval: 'retrieval',
      finalize: 'finalize',
    })
    .addEdge('finalize', END);

  const compiledGraph = workflow.compile();

  debugLogger.stepFinish(stepId, { nodes: 3, edges: 4 });

  /**
   * Invoke the supervisor with a question
   */
  return async (question: string): Promise<FinalResponse> => {
    const execStepId = debugLogger.stepStart('SUPERVISOR_EXEC', 'Executing supervisor workflow', {
      question,
    });

    try {
      // Initialize state
      const initialState: AgentStateType = {
        question,
        retrievalOutput: null,
        validationOutput: null,
        finalAnswer: null,
        retryCount: 0,
      };

      // Execute the workflow
      const result = await compiledGraph.invoke(initialState);

      // Increment retry count for next iteration if needed
      if (result.validationOutput && result.validationOutput.confidence < 70 && result.retryCount < 1) {
        result.retryCount += 1;
      }

      if (!result.retrievalOutput || !result.validationOutput || !result.finalAnswer) {
        throw new Error('Workflow did not complete successfully');
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
