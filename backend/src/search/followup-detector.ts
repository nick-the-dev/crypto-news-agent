/**
 * Follow-up Detection for Conversation Continuity
 *
 * Detects whether a message is:
 * - new_query: Standalone question requiring fresh news search
 * - clarification: Asking about previous response (no new search needed)
 * - refinement: Modifying/narrowing previous search (search with context)
 */

import { ChatOpenAI } from '@langchain/openai';
import { ChatPromptTemplate, SystemMessagePromptTemplate, HumanMessagePromptTemplate } from '@langchain/core/prompts';
import { RunnableSequence } from '@langchain/core/runnables';
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

// Fast heuristic patterns for obvious cases
const CLARIFICATION_PATTERNS = [
  /^(are you sure|really|why|explain|what do you mean|elaborate|more detail)/i,
  /^(tell me more|go on|continue|expand)$/i,
  /^(can you explain|please explain|explain that)/i,
  /^(how come|why is that|why do you say|what makes you say)/i,
  /^(yes|no|ok|okay|sure|thanks|thank you)$/i,
  /^(what|how|why)\?$/i,
  /\?$/,  // Single word questions ending with ?
];

const REFINEMENT_PATTERNS = [
  /^(what about|how about|and what about|but what about)\s+/i,
  /^(focus on|narrow to|specifically|just|only)\s+/i,
  /^(and|but)\s+(what about|how about)/i,
  /^(in the last \d+ days?|this week|today|yesterday)/i,
  /^(show me|give me|get me)\s+(more|less|only)/i,
  /^(filter|limit|exclude|include)\s+/i,
];

// Patterns that indicate a NEW query (override other patterns)
const NEW_QUERY_PATTERNS = [
  /^what('s| is) (happening|going on|the latest|new)/i,
  /^(tell me about|what do you know about|search for)\s+/i,
  /^(news|update|latest)\s+(on|about|for)/i,
  /bitcoin|ethereum|crypto|defi|nft|blockchain/i,  // Crypto terms suggest new query
];

/**
 * Fast heuristic check - no LLM call
 * Returns null if uncertain, allowing LLM detection to run
 */
export function detectFollowupFast(
  message: string,
  hasHistory: boolean
): FollowupResult | null {
  // No history = definitely new query
  if (!hasHistory) {
    return {
      type: 'new_query',
      confidence: 1.0,
      reasoning: 'First message in conversation',
    };
  }

  const trimmed = message.trim();
  const wordCount = trimmed.split(/\s+/).length;

  // Very short messages (1-3 words) are likely clarifications
  if (wordCount <= 3) {
    // Check if it has crypto terms - then it's likely a new query
    for (const pattern of NEW_QUERY_PATTERNS) {
      if (pattern.test(trimmed)) {
        return {
          type: 'new_query',
          confidence: 0.8,
          reasoning: `Short message with crypto topic: ${trimmed}`,
        };
      }
    }

    // Check for clarification patterns
    for (const pattern of CLARIFICATION_PATTERNS) {
      if (pattern.test(trimmed)) {
        return {
          type: 'clarification',
          confidence: 0.9,
          reasoning: `Matched clarification pattern`,
        };
      }
    }
  }

  // Check for explicit new query patterns (crypto topics)
  for (const pattern of NEW_QUERY_PATTERNS) {
    if (pattern.test(trimmed) && wordCount > 3) {
      return {
        type: 'new_query',
        confidence: 0.85,
        reasoning: `Matched new query pattern with crypto topic`,
      };
    }
  }

  // Check for refinement patterns
  for (const pattern of REFINEMENT_PATTERNS) {
    if (pattern.test(trimmed)) {
      return {
        type: 'refinement',
        confidence: 0.85,
        reasoning: `Matched refinement pattern`,
      };
    }
  }

  // Check for clarification patterns (longer messages)
  for (const pattern of CLARIFICATION_PATTERNS) {
    if (pattern.test(trimmed)) {
      return {
        type: 'clarification',
        confidence: 0.8,
        reasoning: `Matched clarification pattern`,
      };
    }
  }

  // Uncertain - need LLM
  return null;
}

const FollowupSchema = z.object({
  type: z.enum(['new_query', 'clarification', 'refinement']),
  confidence: z.number().min(0).max(1),
  reasoning: z.string(),
  refinedQuery: z.string().optional(),
});

const SYSTEM_PROMPT = `You analyze conversations to determine if the latest message is a follow-up to previous messages.

Classify messages into one of three types:

1. "new_query" - User is asking about a DIFFERENT topic. They want fresh information unrelated to the conversation.
   Examples: "What's the latest on Ethereum?", "Tell me about DeFi news"

2. "clarification" - User wants more explanation of the PREVIOUS answer. No new search needed.
   Examples: "Are you sure?", "Why?", "Can you explain that?", "What do you mean?"

3. "refinement" - User wants to MODIFY the previous search with constraints. Same topic, different scope.
   Examples: "What about just Solana?", "Focus on the last 3 days", "Only bullish news"
   For refinements, also provide a "refinedQuery" that combines the original topic with the new constraints.

Return JSON with: type, confidence (0-1), reasoning, and refinedQuery (if type is refinement).`;

const HUMAN_PROMPT = `CONVERSATION HISTORY:
{history}

NEW MESSAGE: "{message}"

Classify this message:`;

/**
 * LLM-based follow-up detection for ambiguous cases
 */
export async function detectFollowupLLM(
  message: string,
  context: ConversationContext,
  llm: ChatOpenAI
): Promise<FollowupResult> {
  const stepId = debugLogger.stepStart('FOLLOWUP_DETECT', 'LLM detection', {
    messagePreview: message.substring(0, 50),
  });

  try {
    const history = formatContextForPrompt(context, 2000);

    const prompt = ChatPromptTemplate.fromMessages([
      SystemMessagePromptTemplate.fromTemplate(SYSTEM_PROMPT),
      HumanMessagePromptTemplate.fromTemplate(HUMAN_PROMPT),
    ]);

    const structuredLLM = llm.withStructuredOutput(FollowupSchema);

    const chain = RunnableSequence.from([prompt, structuredLLM]);

    const result = await chain.invoke({ history, message });

    debugLogger.stepFinish(stepId, {
      type: result.type,
      confidence: result.confidence,
    });

    // If confidence is too low, default to new_query (safer)
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
      refinedQuery: result.refinedQuery,
    };
  } catch (error) {
    debugLogger.stepError(stepId, 'FOLLOWUP_DETECT', 'LLM detection failed', error);
    // Fallback to new_query on error
    return {
      type: 'new_query',
      confidence: 0.5,
      reasoning: 'Detection failed, defaulting to new query',
    };
  }
}

/**
 * Main detection function - tries fast detection first, falls back to LLM
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

  // First try fast detection
  const fastResult = detectFollowupFast(message, context.turns.length > 0);
  if (fastResult) {
    debugLogger.stepFinish(stepId, {
      method: 'fast',
      type: fastResult.type,
      confidence: fastResult.confidence,
    });
    return fastResult;
  }

  // Use LLM for uncertain cases
  if (llm) {
    const llmResult = await detectFollowupLLM(message, context, llm);
    debugLogger.stepFinish(stepId, {
      method: 'llm',
      type: llmResult.type,
      confidence: llmResult.confidence,
    });
    return llmResult;
  }

  // No LLM available - default to new query
  debugLogger.stepFinish(stepId, { method: 'default', type: 'new_query' });
  return {
    type: 'new_query',
    confidence: 0.5,
    reasoning: 'No LLM available, defaulting to new query',
  };
}
