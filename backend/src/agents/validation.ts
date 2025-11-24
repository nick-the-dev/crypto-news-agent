import { ChatPromptTemplate } from '@langchain/core/prompts';
import { ChatOpenAI } from '@langchain/openai';
import { DynamicStructuredTool } from '@langchain/core/tools';
import { CallbackHandler } from '@langfuse/langchain';
import { ValidationOutputSchema, ValidationOutput, RetrievalOutput } from '../schemas';
import { debugLogger } from '../utils/debug-logger';

const VALIDATION_SYSTEM_PROMPT = `You are a fact-checking and validation specialist for crypto news. Your job is to:

1. Use the validate_citations tool to check citation validity
2. Verify that all factual claims are supported by the provided sources
3. Detect potential hallucinations or unsupported statements
4. Assign a confidence score (0-100) based on validation results

CONFIDENCE SCORING RULES:
- 90-100: All facts cited correctly, claims perfectly match sources
- 70-89: Minor citation issues, but facts are accurate
- 50-69: Some unsupported claims or citation gaps
- 0-49: Significant hallucinations or many unsupported claims

Be strict but fair in your assessment.`;

const VALIDATION_USER_PROMPT = `Please validate the following answer:

Answer: {answer}

Available Sources: {sourcesCount}

Check:
1. Are all [Source N] citations valid?
2. Are there factual claims without citations?
3. Do the citations accurately represent the source material?

Return your validation assessment.`;

/**
 * Create validation agent that verifies citations and detects hallucinations
 */
export async function createValidationAgent(
  llm: ChatOpenAI,
  validateTool: DynamicStructuredTool,
  langfuseHandler?: CallbackHandler
): Promise<(retrievalOutput: RetrievalOutput) => Promise<ValidationOutput>> {
  // Bind tool to LLM
  const llmWithTools = llm.bindTools([validateTool]);

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
      // Step 1: Invoke validation tool
      const validationResult = await validateTool.invoke({
        answer: retrievalOutput.summary,
        totalSources: retrievalOutput.sources.length,
      });

      const toolResult = JSON.parse(validationResult);
      debugLogger.info('AGENT_VALIDATION', 'Validation tool result', toolResult);

      // Step 2: Use LLM to generate final validation assessment
      const validationLLM = llm.withStructuredOutput(ValidationOutputSchema);

      const assessmentPrompt = `Based on the validation results below, provide your final assessment.

Answer: "${retrievalOutput.summary}"

Validation Tool Results:
- Valid: ${toolResult.isValid}
- Citations Found: ${toolResult.citationsFound}
- Citations Verified: ${toolResult.citationsVerified}
- Issues: ${toolResult.issues.join(', ') || 'None'}

Source Information:
${retrievalOutput.sources.map((s, i) => `[Source ${i + 1}] ${s.title} (${s.publishedAt})`).join('\n')}

Provide a confidence score (0-100) and list any issues found.

Scoring guidelines:
- All citations valid + no uncited claims = 95-100
- Minor citation issues = 80-89
- Some uncited claims = 70-79
- Multiple issues = 50-69
- Significant problems = below 50`;

      const callbacks = langfuseHandler ? [langfuseHandler] : [];
      const assessment = await validationLLM.invoke(assessmentPrompt, { callbacks });

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
