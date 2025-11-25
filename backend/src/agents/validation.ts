import { ChatOpenAI } from '@langchain/openai';
import { DynamicStructuredTool } from '@langchain/core/tools';
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
      const validationLLM = llm.withStructuredOutput(ValidationOutputSchema);

      const assessmentPrompt = `Score this answer (0-100). Valid=${toolResult.isValid}, Citations: ${toolResult.citationsVerified}/${toolResult.citationsFound}.
Issues: ${toolResult.issues.join(', ') || 'None'}
Answer: "${retrievalOutput.summary.substring(0, 200)}..."`;

      const assessment = await validationLLM.invoke(assessmentPrompt, {
        callbacks,
        runName: 'Validation: Assess Citations',
      });

      const output: ValidationOutput = {
        confidence: assessment.confidence,
        isValid: assessment.confidence >= 70,
        issues: assessment.issues,
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
