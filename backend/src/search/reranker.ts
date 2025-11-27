import { HybridSearchResult } from './hybrid-search';

export interface RerankedResult extends HybridSearchResult {
  finalScore: number;
  scoreBreakdown: string;
}

interface ScoringWeights {
  rrf: number;
  titleMatch: number;
  contentMatch: number;
  recency: number;
  chunkType: number;
}

const DEFAULT_WEIGHTS: ScoringWeights = {
  rrf: 0.35,
  titleMatch: 0.25,
  contentMatch: 0.15,
  recency: 0.15,
  chunkType: 0.10,
};

export function rerank(
  query: string,
  candidates: HybridSearchResult[],
  options: { topK?: number; weights?: Partial<ScoringWeights> } = {}
): RerankedResult[] {
  const { topK = 7, weights = {} } = options;
  const w = { ...DEFAULT_WEIGHTS, ...weights };
  const queryTerms = query.toLowerCase().split(/\s+/).filter(t => t.length > 2);

  const scored = candidates.map(c => {
    const scores = {
      rrf: c.rrfScore * w.rrf,
      titleMatch: calcTermMatchScore(c.title, queryTerms) * w.titleMatch,
      contentMatch: calcTermMatchScore(c.chunkContent, queryTerms) * w.contentMatch,
      recency: calcRecencyScore(c.publishedAt) * w.recency,
      chunkType: calcChunkTypeScore(c.isIntro, c.isSummary) * w.chunkType,
    };

    const finalScore = Object.values(scores).reduce((a, b) => a + b, 0);
    const scoreBreakdown = Object.entries(scores)
      .map(([k, v]) => `${k}=${v.toFixed(3)}`)
      .join(', ');

    return { ...c, finalScore, scoreBreakdown };
  });

  return scored
    .sort((a, b) => b.finalScore - a.finalScore)
    .slice(0, topK);
}

function calcTermMatchScore(text: string, terms: string[]): number {
  if (!terms.length) return 0;
  const lower = text.toLowerCase();
  const matches = terms.filter(t => lower.includes(t)).length;
  return matches / terms.length;
}

function calcRecencyScore(publishedAt: Date): number {
  const hoursAgo = (Date.now() - publishedAt.getTime()) / (1000 * 60 * 60);
  if (hoursAgo < 24) return 1.0;
  if (hoursAgo < 72) return 0.7;
  if (hoursAgo < 168) return 0.4; // 1 week
  return 0.2;
}

function calcChunkTypeScore(isIntro: boolean, isSummary: boolean): number {
  if (isSummary) return 1.0;
  if (isIntro) return 0.8;
  return 0.5;
}

export function deduplicateByArticle(results: RerankedResult[]): RerankedResult[] {
  const seen = new Map<string, RerankedResult>();

  for (const result of results) {
    const existing = seen.get(result.articleId);
    if (!existing || result.finalScore > existing.finalScore) {
      seen.set(result.articleId, result);
    }
  }

  return Array.from(seen.values()).sort((a, b) => b.finalScore - a.finalScore);
}
