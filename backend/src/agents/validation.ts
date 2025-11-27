import { ChatOpenAI } from '@langchain/openai';
import { DynamicStructuredTool } from '@langchain/core/tools';
import { ChatPromptTemplate } from '@langchain/core/prompts';
import { RunnableSequence } from '@langchain/core/runnables';
import { CallbackHandler } from '@langfuse/langchain';
import { ValidationOutputSchema, ValidationOutput, RetrievalOutput } from '../schemas';
import { debugLogger } from '../utils/debug-logger';

/**
 * Create validation agent that verifies citations and detects hallucinations
 */
export async function createValidationAgent(
  llm: ChatOpenAI,
  validateTool: DynamicStructuredTool,
  langfuseHandler?: CallbackHandler
): Promise<(retrievalOutput: RetrievalOutput) => Promise<ValidationOutput>> {
  return async (retrievalOutput: RetrievalOutput): Promise<ValidationOutput> => {
    const stepId = debugLogger.stepStart('AGENT_VALIDATION', 'Validation agent executing', {
      sourcesCount: retrievalOutput.sources.length,
      citationCount: retrievalOutput.citationCount,
    });

    try {
      const callbacks = langfuseHandler ? [langfuseHandler] : [];

      // Step 1: Invoke validation tool
      const validationResult = await validateTool.invoke({
        answer: retrievalOutput.summary,
        totalSources: retrievalOutput.sources.length,
      });

      const toolResult = JSON.parse(validationResult);
      debugLogger.info('AGENT_VALIDATION', 'Validation tool result', toolResult);

      // Step 2: Use LLM to generate final validation assessment
      // CRITICAL: Use RunnableSequence for proper LangFuse sessionId tracking
      // Direct llm.invoke() does NOT trigger handleChainStart, causing orphaned traces with NULL sessionId
      // NOTE: Do NOT truncate the answer - LangFuse should capture full input/output for observability
      const validationLLM = llm.withStructuredOutput(ValidationOutputSchema);

      const assessmentPromptTemplate = ChatPromptTemplate.fromTemplate(
        `Score the citation quality of this answer (0-100).

Validation Results:
- Citations verified: {citationsVerified}/{citationsFound}
- Tool validation passed: {isValid}
- Issues found: {issues}

Scoring Guide:
- 90-100: All citations verified, no invalid references
- 70-89: Most citations verified, minor issues
- 50-69: Some citations missing or invalid
- Below 50: Major citation problems

If citationsVerified equals citationsFound and no issues were found, score should be 90+.
Transition sentences, conclusions, and opinion summaries don't need citations.

Answer to evaluate:
"{fullAnswer}"`
      );

      const validationChain = RunnableSequence.from([
        assessmentPromptTemplate,
        validationLLM,
      ]);

      const assessment = await validationChain.invoke(
        {
          isValid: toolResult.isValid,
          citationsVerified: toolResult.citationsVerified,
          citationsFound: toolResult.citationsFound,
          issues: toolResult.issues.join(', ') || 'None',
          fullAnswer: retrievalOutput.summary,  // Full answer for proper LangFuse tracing
        },
        {
          callbacks,
          runName: 'Validation: Assess Citations',
        }
      );

      // Use tool's issues (more reliable) but LLM's confidence score
      // The tool does actual citation counting; LLM provides holistic scoring
      const output: ValidationOutput = {
        confidence: assessment.confidence,
        isValid: assessment.confidence >= 70,
        issues: toolResult.issues,  // Trust the tool's issues, not LLM's
        citationsVerified: toolResult.citationsVerified,
        citationsTotal: toolResult.citationsFound,
      };

      debugLogger.stepFinish(stepId, {
        confidence: output.confidence,
        isValid: output.isValid,
        issuesCount: output.issues.length,
      });

      return output;
    } catch (error) {
      debugLogger.stepError(stepId, 'AGENT_VALIDATION', 'Error in validation agent', error);
      throw error;
    }
  };
}
