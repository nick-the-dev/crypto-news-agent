/**
 * Follow-up Detection for Conversation Continuity
 *
 * Simple LLM-based classification - no hardcoded patterns.
 * Detects whether a message is:
 * - new_query: Standalone question requiring fresh news search
 * - clarification: Asking about previous response (no new search needed)
 * - refinement: Modifying/narrowing previous search (search with context)
 */

import { ChatOpenAI } from '@langchain/openai';
import { ChatPromptTemplate } from '@langchain/core/prompts';
import { z } from 'zod';
import { ConversationContext, formatContextForPrompt } from '../utils/conversation-store';
import { debugLogger } from '../utils/debug-logger';

export type FollowupType = 'new_query' | 'clarification' | 'refinement';

export interface FollowupResult {
  type: FollowupType;
  confidence: number;
  reasoning: string;
  refinedQuery?: string;
}

const FollowupSchema = z.object({
  type: z.enum(['new_query', 'clarification', 'refinement']),
  confidence: z.number().min(0).max(1),
  reasoning: z.string(),
  refinedQuery: z.string().nullable(),
});

type FollowupLLMOutput = z.infer<typeof FollowupSchema>;

const SYSTEM_PROMPT = `You classify user messages in a crypto news chat.

Types:
1. "new_query" - User wants information about a topic (search needed)
   Examples: "What's the latest on Bitcoin?", "Is Monero still alive?", "Tell me about DeFi"

2. "clarification" - User wants explanation of YOUR PREVIOUS RESPONSE (no search needed)
   Examples: "Why?", "Can you explain that?", "What do you mean by that?"
   IMPORTANT: Only use this if the user is asking about something YOU said, not asking a new question.

3. "refinement" - User wants to modify/narrow the previous search
   Examples: "What about just Solana?", "Focus on the last 3 days", "analyze it more"
   For refinements, generate a "refinedQuery" that explicitly names the topic.

DEFAULT TO "new_query" when uncertain. It's safer to search than to not search.

Return JSON: {type, confidence (0-1), reasoning, refinedQuery (for refinements only)}`;

const HUMAN_PROMPT = `CONVERSATION HISTORY:
{history}

NEW MESSAGE: "{message}"

Classify:`;

/**
 * LLM-based follow-up detection
 */
async function detectWithLLM(
  message: string,
  context: ConversationContext,
  llm: ChatOpenAI
): Promise<FollowupResult> {
  const stepId = debugLogger.stepStart('FOLLOWUP_DETECT', 'LLM classification', {
    messagePreview: message.substring(0, 50),
  });

  try {
    const history = formatContextForPrompt(context, 2000);

    const prompt = ChatPromptTemplate.fromMessages([
      ['system', SYSTEM_PROMPT],
      ['human', HUMAN_PROMPT],
    ]);

    const structuredLLM = llm.withStructuredOutput<FollowupLLMOutput>(FollowupSchema);
    const chain = prompt.pipe(structuredLLM);

    const result = await chain.invoke({ history, message });

    debugLogger.stepFinish(stepId, {
      type: result.type,
      confidence: result.confidence,
    });

    // Low confidence defaults to new_query (safer to search)
    if (result.confidence < 0.6) {
      debugLogger.info('FOLLOWUP_DETECT', 'Low confidence, defaulting to new_query', {
        originalType: result.type,
        confidence: result.confidence,
      });
      return {
        type: 'new_query',
        confidence: result.confidence,
        reasoning: `Low confidence (${result.confidence}) - treating as new query`,
      };
    }

    return {
      type: result.type,
      confidence: result.confidence,
      reasoning: result.reasoning,
      refinedQuery: result.refinedQuery ?? undefined,
    };
  } catch (error) {
    debugLogger.stepError(stepId, 'FOLLOWUP_DETECT', 'LLM classification failed', error);
    // Fallback to new_query on error
    return {
      type: 'new_query',
      confidence: 0.5,
      reasoning: 'Classification failed, defaulting to new query',
    };
  }
}

/**
 * Main detection function - pure LLM-based classification
 */
export async function detectFollowup(
  message: string,
  context: ConversationContext,
  llm?: ChatOpenAI
): Promise<FollowupResult> {
  const stepId = debugLogger.stepStart('FOLLOWUP_DETECT', 'Detecting follow-up type', {
    messagePreview: message.substring(0, 50),
    historyLength: context.turns.length,
  });

  // No history = definitely new query (no LLM needed)
  if (context.turns.length === 0) {
    debugLogger.stepFinish(stepId, { method: 'no_history', type: 'new_query' });
    return {
      type: 'new_query',
      confidence: 1.0,
      reasoning: 'First message in conversation',
    };
  }

  // Use LLM for classification
  if (llm) {
    const result = await detectWithLLM(message, context, llm);
    debugLogger.stepFinish(stepId, {
      method: 'llm',
      type: result.type,
      confidence: result.confidence,
    });
    return result;
  }

  // No LLM available - default to new query
  debugLogger.stepFinish(stepId, { method: 'no_llm', type: 'new_query' });
  return {
    type: 'new_query',
    confidence: 0.5,
    reasoning: 'No LLM available, defaulting to new query',
  };
}
