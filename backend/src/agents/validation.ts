import { ChatPromptTemplate } from '@langchain/core/prompts';
import { ChatOpenAI } from '@langchain/openai';
import { DynamicStructuredTool } from '@langchain/core/tools';
import { CallbackHandler } from '@langfuse/langchain';
import { ValidationOutputSchema, ValidationOutput, RetrievalOutput } from '../schemas';
import { debugLogger } from '../utils/debug-logger';

const VALIDATION_SYSTEM_PROMPT = `Fact-check crypto news citations. Score: 90-100 (all cited), 70-89 (minor issues), 50-69 (gaps), 0-49 (hallucinations).`;

const VALIDATION_USER_PROMPT = `Validate: {answer}
Sources available: {sourcesCount}`;

/**
 * Create validation agent that verifies citations and detects hallucinations
 */
export async function createValidationAgent(
  llm: ChatOpenAI,
  validateTool: DynamicStructuredTool,
  langfuseHandler?: CallbackHandler
): Promise<(retrievalOutput: RetrievalOutput) => Promise<ValidationOutput>> {
  // Create prompt template
  const prompt = ChatPromptTemplate.fromMessages([
    ['system', VALIDATION_SYSTEM_PROMPT],
    ['human', VALIDATION_USER_PROMPT],
  ]);

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
