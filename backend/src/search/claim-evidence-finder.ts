import { hybridSearch } from './hybrid-search';
import { rerank, deduplicateByArticle } from './reranker';
import { OpenRouterEmbeddings } from '../agents/llm';
import { debugLogger } from '../utils/debug-logger';
import { ExpandedQuery } from './query-rewriter';

export interface ClaimMatch {
  claim: string;
  sourceIndex: number;        // Which [Source N] to use (-1 if no match)
  matchingArticle: {
    title: string;
    url: string;
    quote: string;            // Best matching chunk
    similarity: number;       // 0-1 confidence
    publishedAt?: string;     // Article publish date
  } | null;
}

export interface NewSource {
  title: string;
  url: string;
  publishedAt: string;
  quote: string;
  relevance: number;
}

/**
 * Extract sentences without [Source N] citations from a summary.
 * Filters out transition sentences and very short fragments.
 */
export function extractUncitedClaims(summary: string): string[] {
  // Split by sentence boundaries (period, exclamation, question mark followed by space)
  const sentences = summary
    .split(/(?<=[.!?])\s+/)
    .map(s => s.trim())
    .filter(s => s.length > 20);  // Skip tiny fragments

  // Common transition words that don't need citations
  const transitionStarts = [
    'however',
    'overall',
    'in summary',
    'in conclusion',
    'additionally',
    'furthermore',
    'meanwhile',
    'therefore',
    'thus',
    'notably',
    'importantly',
  ];

  return sentences.filter(sentence => {
    // Already has a citation
    const hasCitation = /\[Source \d+\]/.test(sentence);
    if (hasCitation) return false;

    // Is a transition sentence (doesn't need citation)
    const lowerSentence = sentence.toLowerCase();
    const isTransition = transitionStarts.some(w => lowerSentence.startsWith(w));
    if (isTransition) return false;

    // Looks like a factual claim (has numbers, names, or specific details)
    // Keep sentences that contain: percentages, dollar amounts, numbers, or capitalized proper nouns
    const hasFactualContent = /\d+%|\$\d|[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?/.test(sentence);

    return hasFactualContent || sentence.length > 50;  // Keep longer sentences too
  });
}

/**
 * Search for evidence for multiple claims in parallel using vector search.
 * Returns matches with source indices for claims that can be verified.
 */
export async function findEvidenceForClaims(
  claims: string[],
  embeddings: OpenRouterEmbeddings,
  existingSources: Array<{ title: string; url: string }>,
  options: { daysBack?: number; minSimilarity?: number } = {}
): Promise<ClaimMatch[]> {
  const { daysBack = 30, minSimilarity = 0.45 } = options;

  const stepId = debugLogger.stepStart('CLAIM_EVIDENCE', 'Searching evidence for claims', {
    claimsCount: claims.length,
    existingSourcesCount: existingSources.length,
    daysBack,
    minSimilarity,
  });

  // Run all searches in parallel
  const searchPromises = claims.map(async (claim): Promise<ClaimMatch> => {
    try {
      // Create a minimal ExpandedQuery for the claim
      const expandedQuery: ExpandedQuery = {
        original: claim,
        normalized: claim,
        variants: [],
        intent: 'analysis',
        timeframe: null,
      };

      // Vector + lexical search
      const results = await hybridSearch(expandedQuery, embeddings, {
        daysBack,
        limit: 15,
        vectorThreshold: 0.25,  // Lower threshold to catch more candidates
      });

      if (results.length === 0) {
        debugLogger.info('CLAIM_EVIDENCE', 'No results for claim', {
          claim: claim.substring(0, 50) + '...',
        });
        return { claim, sourceIndex: -1, matchingArticle: null };
      }

      // Deduplicate by article and rerank for best match
      const deduplicated = deduplicateByArticle(
        results.map(r => ({ ...r, finalScore: r.rrfScore, scoreBreakdown: '' }))
      );
      const reranked = rerank(claim, deduplicated, { topK: 5 });
      const best = reranked[0];

      // Check if it's good enough
      if (best.finalScore < minSimilarity) {
        debugLogger.info('CLAIM_EVIDENCE', 'Best match below threshold', {
          claim: claim.substring(0, 50) + '...',
          bestScore: best.finalScore.toFixed(3),
          threshold: minSimilarity,
        });
        return { claim, sourceIndex: -1, matchingArticle: null };
      }

      // Check if this article is already in our sources
      const existingIndex = existingSources.findIndex(s => s.url === best.url);

      debugLogger.info('CLAIM_EVIDENCE', 'Found evidence for claim', {
        claim: claim.substring(0, 50) + '...',
        article: best.title.substring(0, 40) + '...',
        score: best.finalScore.toFixed(3),
        existingSourceIndex: existingIndex,
      });

      return {
        claim,
        sourceIndex: existingIndex >= 0 ? existingIndex + 1 : -1,  // 1-indexed for [Source N]
        matchingArticle: {
          title: best.title,
          url: best.url,
          quote: best.chunkContent.substring(0, 250),
          similarity: best.finalScore,
          publishedAt: best.publishedAt,
        },
      };
    } catch (error) {
      debugLogger.warn('CLAIM_EVIDENCE', 'Error searching for claim', {
        claim: claim.substring(0, 50) + '...',
        error: error instanceof Error ? error.message : String(error),
      });
      return { claim, sourceIndex: -1, matchingArticle: null };
    }
  });

  const results = await Promise.all(searchPromises);

  const matched = results.filter(m => m.sourceIndex > 0).length;
  const unmatched = results.filter(m => m.sourceIndex === -1).length;

  debugLogger.stepFinish(stepId, {
    totalClaims: claims.length,
    matched,
    unmatched,
    matchRate: `${((matched / claims.length) * 100).toFixed(1)}%`,
  });

  return results;
}

/**
 * Inject citations into summary based on matched evidence.
 * Adds citations for existing sources and creates new sources for high-confidence matches.
 */
export function injectCitations(
  summary: string,
  claimMatches: ClaimMatch[],
  existingSourcesCount: number
): { updatedSummary: string; citationsAdded: number; newSources: NewSource[] } {
  let updatedSummary = summary;
  let citationsAdded = 0;
  const newSources: NewSource[] = [];
  const addedUrls = new Set<string>();  // Dedupe new sources

  for (const match of claimMatches) {
    if (!match.matchingArticle) continue;

    let sourceIndex = match.sourceIndex;

    // New source: article not in existing topSources but has high confidence
    if (sourceIndex === -1 && match.matchingArticle.similarity >= 0.5) {
      // Check if we already added this article as a new source
      if (!addedUrls.has(match.matchingArticle.url)) {
        addedUrls.add(match.matchingArticle.url);
        newSources.push({
          title: match.matchingArticle.title,
          url: match.matchingArticle.url,
          publishedAt: match.matchingArticle.publishedAt || new Date().toISOString(),
          quote: match.matchingArticle.quote,
          relevance: match.matchingArticle.similarity,
        });
      }
      // Assign source index (1-indexed, after existing sources)
      const newSourceIdx = newSources.findIndex(s => s.url === match.matchingArticle!.url);
      sourceIndex = existingSourcesCount + newSourceIdx + 1;
    }

    // Inject citation if we have a valid source index
    if (sourceIndex > 0) {
      // Escape special regex characters in the claim
      const claimEscaped = match.claim.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

      // Match the claim only if it doesn't already have a citation following it
      const regex = new RegExp(`(${claimEscaped})(?!\\s*\\[Source)`, 'i');

      if (regex.test(updatedSummary)) {
        updatedSummary = updatedSummary.replace(
          regex,
          `$1 [Source ${sourceIndex}]`
        );
        citationsAdded++;

        const isNewSource = sourceIndex > existingSourcesCount;
        debugLogger.info('CLAIM_EVIDENCE', 'Injected citation', {
          claim: match.claim.substring(0, 40) + '...',
          sourceIndex,
          isNewSource,
        });
      }
    }
  }

  debugLogger.info('CLAIM_EVIDENCE', 'Citation injection complete', {
    citationsAdded,
    existingSourceMatches: claimMatches.filter(m => m.sourceIndex > 0).length,
    newSourcesAdded: newSources.length,
  });

  return { updatedSummary, citationsAdded, newSources };
}
