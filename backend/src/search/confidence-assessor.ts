import { RerankedResult } from './reranker';

export type ConfidenceLevel = 'high' | 'medium' | 'low' | 'none';

export interface ConfidenceAssessment {
  level: ConfidenceLevel;
  score: number;
  caveat?: string;
  resultCount: number;
  topScore: number;
  avgScore: number;
}

const CAVEATS: Record<ConfidenceLevel, string | undefined> = {
  high: undefined,
  medium: 'Note: Results may be partially relevant. Please verify the information.',
  low: 'Warning: Limited relevant information found. Results may not fully answer your query.',
  none: 'No relevant articles found in the database for this query.',
};

export function assessConfidence(results: RerankedResult[]): ConfidenceAssessment {
  if (results.length === 0) {
    return {
      level: 'none',
      score: 0,
      caveat: CAVEATS.none,
      resultCount: 0,
      topScore: 0,
      avgScore: 0,
    };
  }

  const topScore = results[0]?.finalScore || 0;
  const avgScore = results.reduce((sum, r) => sum + r.finalScore, 0) / results.length;
  // Lowered threshold from 0.4 to 0.25 - reranker finalScores typically max around 0.4-0.5
  const strongMatches = results.filter(r => r.finalScore > 0.25).length;

  let level: ConfidenceLevel;
  let score: number;

  // Adjusted thresholds: RRF contributes very little to finalScore (~0.01 max)
  // Realistic finalScores range from 0.15 to 0.45, so thresholds adjusted accordingly
  if (topScore > 0.35 && strongMatches >= 2) {
    level = 'high';
    score = Math.min(Math.round(topScore * 100 + 30), 95);
  } else if (topScore > 0.2 || strongMatches >= 1) {
    level = 'medium';
    score = Math.min(Math.round(avgScore * 100 + 40), 75);
  } else {
    level = 'low';
    score = Math.max(Math.round(avgScore * 100), 15);
  }

  return {
    level,
    score,
    caveat: CAVEATS[level],
    resultCount: results.length,
    topScore,
    avgScore,
  };
}
