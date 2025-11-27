import { ChatOpenAI } from '@langchain/openai';
import { sanitizeForLLM } from '../utils/sanitize';

export type QueryIntent = 'retrieval' | 'analysis';

export interface IntentResult {
  intent: QueryIntent;
  confidence: number;
  reasoning: string;
  timeframeDays?: number;
}

const ANALYTICAL_KEYWORDS = [
  'predict', 'prediction', 'forecast',
  'trend', 'trends', 'trending',
  'analysis', 'analyze', 'analyse',
  'insight', 'insights',
  'based on', 'over the last', 'in the past',
  'what will happen', 'outlook', 'sentiment',
  'summary of', 'summarize', 'overview',
  'pattern', 'patterns',
];

const TIMEFRAME_PATTERNS: Array<{ pattern: RegExp; days: number }> = [
  { pattern: /last\s*(\d+)\s*days?/i, days: -1 }, // Dynamic
  { pattern: /past\s*(\d+)\s*days?/i, days: -1 },
  { pattern: /last\s*week/i, days: 7 },
  { pattern: /past\s*week/i, days: 7 },
  { pattern: /last\s*month/i, days: 30 },
  { pattern: /past\s*month/i, days: 30 },
  { pattern: /last\s*(\d+)\s*weeks?/i, days: -7 }, // Multiply by 7
  { pattern: /(\d+)\s*days?\s*ago/i, days: -1 },
];

/**
 * Fast keyword-based intent detection
 */
export function detectIntentFast(query: string): IntentResult {
  const lower = query.toLowerCase();

  // Check for analytical keywords
  const matchedKeywords = ANALYTICAL_KEYWORDS.filter(kw => lower.includes(kw));
  const isAnalytical = matchedKeywords.length > 0;

  // Extract timeframe
  let timeframeDays: number | undefined;
  for (const { pattern, days } of TIMEFRAME_PATTERNS) {
    const match = lower.match(pattern);
    if (match) {
      if (days === -1 && match[1]) {
        timeframeDays = parseInt(match[1], 10);
      } else if (days === -7 && match[1]) {
        timeframeDays = parseInt(match[1], 10) * 7;
      } else if (days > 0) {
        timeframeDays = days;
      }
      break;
    }
  }

  return {
    intent: isAnalytical ? 'analysis' : 'retrieval',
    confidence: isAnalytical ? 0.7 + (matchedKeywords.length * 0.1) : 0.8,
    reasoning: isAnalytical
      ? `Matched keywords: ${matchedKeywords.join(', ')}`
      : 'No analytical keywords detected',
    timeframeDays,
  };
}

/**
 * LLM-based intent detection for ambiguous cases
 */
export async function detectIntentLLM(query: string, llm: ChatOpenAI): Promise<IntentResult> {
  // Sanitize query to prevent prompt injection attacks
  const { sanitized: sanitizedQuery, suspicious } = sanitizeForLLM(query);

  if (suspicious) {
    // Log suspicious input but continue with sanitized version
    console.warn('[SECURITY] Suspicious input detected in intent detector:', query.substring(0, 100));
  }

  const prompt = `Classify this query:
"${sanitizedQuery}"

Is this:
- "retrieval": User wants specific news articles or facts
- "analysis": User wants trends, predictions, sentiment analysis, or synthesis across multiple articles

Return JSON: {"intent": "retrieval"|"analysis", "confidence": 0-1, "reasoning": "...", "timeframeDays": number|null}`;

  try {
    const response = await llm.invoke(prompt);
    const content = typeof response.content === 'string' ? response.content : String(response.content);
    const parsed = JSON.parse(content.replace(/```json?\n?|\n?```/g, '').trim());

    return {
      intent: parsed.intent === 'analysis' ? 'analysis' : 'retrieval',
      confidence: Math.min(Math.max(parsed.confidence || 0.5, 0), 1),
      reasoning: parsed.reasoning || 'LLM classification',
      timeframeDays: parsed.timeframeDays || undefined,
    };
  } catch {
    return detectIntentFast(query);
  }
}

/**
 * LLM-based intent detection (always uses LLM for accuracy)
 * Falls back to fast detection only on LLM failure
 */
export async function detectIntent(query: string, llm: ChatOpenAI): Promise<IntentResult> {
  // Always use LLM for accurate intent classification
  // The ~500ms cost is worth it to avoid routing errors
  return detectIntentLLM(query, llm);
}
