import { ChatOpenAI } from '@langchain/openai';
import { sanitizeForLLM } from '../utils/sanitize';

export interface ExpandedQuery {
  original: string;
  normalized: string;
  variants: string[];
  intent: 'price' | 'news' | 'analysis' | 'prediction' | 'general';
  timeframe: 'today' | 'week' | 'month' | null;
}

const CRYPTO_SLANG: Record<string, string> = {
  crypt: 'cryptocurrency',
  btc: 'Bitcoin',
  eth: 'Ethereum',
  sol: 'Solana',
  ada: 'Cardano',
  xrp: 'Ripple',
  doge: 'Dogecoin',
  moon: 'price increase bullish',
  mooning: 'price increasing rapidly',
  dump: 'price decrease bearish',
  dumping: 'price decreasing rapidly',
  hodl: 'hold long-term investment',
  fud: 'fear uncertainty doubt negative',
  fomo: 'fear of missing out buying pressure',
  whale: 'large holder institutional investor',
  rekt: 'significant loss crash',
  dyor: 'research investment analysis',
  defi: 'decentralized finance',
  nft: 'non-fungible token',
  altcoin: 'alternative cryptocurrency',
  stablecoin: 'stable cryptocurrency USDT USDC',
};

const REWRITE_PROMPT = `Expand this crypto query for search. Be helpful but concise (max 30 words).

Query: "{query}"

Return JSON only:
{
  "normalized": "expanded query with key crypto terms (max 30 words)",
  "variants": ["variant 1", "variant 2"],
  "intent": "price|news|analysis|prediction|general"
}`;

export async function rewriteQuery(query: string, llm: ChatOpenAI): Promise<ExpandedQuery> {
  const basicExpanded = expandSlang(query);
  const timeframe = extractTimeframe(query);

  // Sanitize query to prevent prompt injection attacks
  const { sanitized: sanitizedQuery, suspicious } = sanitizeForLLM(query);

  if (suspicious) {
    // Log suspicious input but continue with sanitized version
    console.warn('[SECURITY] Suspicious input detected in query rewriter:', query.substring(0, 100));
  }

  try {
    const response = await llm.invoke(REWRITE_PROMPT.replace('{query}', sanitizedQuery));
    const content = typeof response.content === 'string' ? response.content : String(response.content);
    const parsed = JSON.parse(content.replace(/```json?\n?|\n?```/g, '').trim());

    return {
      original: query,
      normalized: parsed.normalized || basicExpanded,
      variants: parsed.variants || [basicExpanded],
      intent: parsed.intent || 'general',
      timeframe,
    };
  } catch {
    return {
      original: query,
      normalized: basicExpanded,
      variants: [basicExpanded],
      intent: 'general',
      timeframe,
    };
  }
}

function expandSlang(query: string): string {
  let expanded = query.toLowerCase();
  for (const [slang, replacement] of Object.entries(CRYPTO_SLANG)) {
    expanded = expanded.replace(new RegExp(`\\b${slang}\\b`, 'gi'), replacement);
  }
  return expanded;
}

function extractTimeframe(query: string): ExpandedQuery['timeframe'] {
  const q = query.toLowerCase();
  if (/\btoday\b|\bright now\b|\bcurrently\b/.test(q)) return 'today';
  if (/\bweek\b|\b7 days?\b|\blast week\b/.test(q)) return 'week';
  if (/\bmonth\b|\b30 days?\b|\blast month\b/.test(q)) return 'month';
  return null;
}
