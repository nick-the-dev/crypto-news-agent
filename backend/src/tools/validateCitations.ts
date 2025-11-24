import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { debugLogger } from '../utils/debug-logger';

interface ValidationIssue {
  type: 'invalid_citation' | 'uncited_claim' | 'hallucination';
  message: string;
}

/**
 * Extract all [Source N] citations from text
 */
function extractCitations(text: string): number[] {
  const citationRegex = /\[Source (\d+)\]/g;
  const citations: number[] = [];
  let match;

  while ((match = citationRegex.exec(text)) !== null) {
    citations.push(parseInt(match[1], 10));
  }

  return [...new Set(citations)]; // Remove duplicates
}

/**
 * Split text into sentences for uncited claim detection
 */
function splitIntoSentences(text: string): string[] {
  return text
    .split(/[.!?]+/)
    .map(s => s.trim())
    .filter(s => s.length > 20); // Ignore short fragments
}

/**
 * Create validateCitations tool
 */
export function createValidateCitationsTool(): DynamicStructuredTool {
  return new DynamicStructuredTool({
    name: 'validate_citations',
    description: 'Validate that all [Source N] citations in the answer are valid and match the available sources. Returns validation results with issues found.',
    schema: z.object({
      answer: z.string().describe('The answer text to validate'),
      totalSources: z.number().int().min(0).describe('Total number of available sources'),
    }),
    func: async ({ answer, totalSources }) => {
      const stepId = debugLogger.stepStart('TOOL_VALIDATE_CITATIONS', 'Validating citations', {
        answerLength: answer.length,
        totalSources,
      });

      const issues: ValidationIssue[] = [];

      try {
        // Step 1: Extract all citations
        const citations = extractCitations(answer);
        debugLogger.info('TOOL_VALIDATE_CITATIONS', 'Extracted citations', {
          citations,
          count: citations.length,
        });

        // Step 2: Validate each citation
        let citationsVerified = 0;
        for (const citationNum of citations) {
          if (citationNum < 1 || citationNum > totalSources) {
            issues.push({
              type: 'invalid_citation',
              message: `Invalid citation [Source ${citationNum}] - only ${totalSources} sources available`,
            });
          } else {
            citationsVerified++;
          }
        }

        // Step 3: Check for uncited claims
        const sentences = splitIntoSentences(answer);
        const uncitedSentences = sentences.filter(s => !s.includes('[Source'));

        // Allow some uncited sentences (transitions, summaries, conclusions)
        const transitionWords = [
          'however',
          'overall',
          'in summary',
          'in conclusion',
          'additionally',
          'furthermore',
          'moreover',
          'therefore',
        ];

        const genuineUncitedClaims = uncitedSentences.filter(
          s => !transitionWords.some(word => s.toLowerCase().includes(word))
        );

        if (genuineUncitedClaims.length > 2) {
          issues.push({
            type: 'uncited_claim',
            message: `Found ${genuineUncitedClaims.length} potentially uncited factual claims`,
          });
        }

        // Step 4: Calculate validation result
        const isValid = issues.length === 0;
        const confidence = isValid ? 100 : Math.max(0, 100 - (issues.length * 15));

        const result = {
          isValid,
          confidence,
          citationsFound: citations.length,
          citationsVerified,
          issues: issues.map(i => `[${i.type}] ${i.message}`),
        };

        debugLogger.stepFinish(stepId, result);

        return JSON.stringify(result);
      } catch (error) {
        debugLogger.stepError(stepId, 'TOOL_VALIDATE_CITATIONS', 'Error validating citations', error);
        throw error;
      }
    },
  });
}
