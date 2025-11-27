import { Prisma } from '@prisma/client';
import { prisma } from '../utils/db';
import { OpenRouterEmbeddings } from '../agents/llm';
import { ExpandedQuery } from './query-rewriter';
import { sanitizeLexicalTerms } from '../utils/sanitize';

export interface HybridSearchResult {
  chunkId: string;
  chunkContent: string;
  chunkIndex: number;
  isIntro: boolean;
  isSummary: boolean;
  articleId: string;
  title: string;
  summary: string | null;
  url: string;
  source: string;
  publishedAt: Date;
  vectorScore: number;
  lexicalScore: number;
  rrfScore: number;
}

interface RawVectorResult {
  chunkId: string;
  chunkContent: string;
  chunkIndex: number;
  isIntro: boolean;
  isSummary: boolean;
  articleId: string;
  title: string;
  summary: string | null;
  url: string;
  source: string;
  publishedAt: Date;
  similarity: number;
}

interface RawLexicalResult {
  chunkId: string;
  chunkContent: string;
  chunkIndex: number;
  isIntro: boolean;
  isSummary: boolean;
  articleId: string;
  title: string;
  summary: string | null;
  url: string;
  source: string;
  publishedAt: Date;
  rank: number;
}

const RRF_K = 60; // Reciprocal Rank Fusion constant

export async function hybridSearch(
  expandedQuery: ExpandedQuery,
  embeddings: OpenRouterEmbeddings,
  options: { daysBack?: number; limit?: number; vectorThreshold?: number } = {}
): Promise<HybridSearchResult[]> {
  const { daysBack = 7, limit = 30, vectorThreshold = 0.3 } = options;

  const dateFilter = new Date();
  dateFilter.setDate(dateFilter.getDate() - daysBack);

  const queryEmbedding = await embeddings.embedQuery(expandedQuery.normalized);
  const embeddingStr = `[${queryEmbedding.join(',')}]`;

  const [vectorResults, lexicalResults] = await Promise.all([
    vectorSearch(embeddingStr, dateFilter, limit, vectorThreshold),
    lexicalSearch(expandedQuery.normalized, dateFilter, limit),
  ]);

  return mergeWithRRF(vectorResults, lexicalResults);
}

async function vectorSearch(
  embeddingStr: string,
  dateFilter: Date,
  limit: number,
  threshold: number
): Promise<RawVectorResult[]> {
  return prisma.$queryRaw<RawVectorResult[]>`
    SELECT
      c.id as "chunkId",
      c.content as "chunkContent",
      c."chunkIndex",
      c."isIntro",
      c."isSummary",
      a.id as "articleId",
      a.title,
      a.summary,
      a.url,
      a.source,
      a."publishedAt",
      1 - (e.embedding <=> ${embeddingStr}::vector) as similarity
    FROM "ArticleEmbedding" e
    JOIN "ArticleChunk" c ON e."chunkId" = c.id
    JOIN "Article" a ON c."articleId" = a.id
    WHERE a."publishedAt" >= ${dateFilter}
      AND (1 - (e.embedding <=> ${embeddingStr}::vector)) >= ${threshold}
    ORDER BY similarity DESC
    LIMIT ${limit}
  `;
}

async function lexicalSearch(
  query: string,
  dateFilter: Date,
  limit: number
): Promise<RawLexicalResult[]> {
  // Use centralized sanitization for lexical search terms
  // This prevents SQL injection and limits term count
  const terms = sanitizeLexicalTerms(query);

  if (!terms) return [];

  try {
    return await prisma.$queryRaw<RawLexicalResult[]>`
      SELECT
        c.id as "chunkId",
        c.content as "chunkContent",
        c."chunkIndex",
        c."isIntro",
        c."isSummary",
        a.id as "articleId",
        a.title,
        a.summary,
        a.url,
        a.source,
        a."publishedAt",
        ts_rank(c."searchVector", to_tsquery('english', ${terms})) as rank
      FROM "ArticleChunk" c
      JOIN "Article" a ON c."articleId" = a.id
      WHERE a."publishedAt" >= ${dateFilter}
        AND c."searchVector" @@ to_tsquery('english', ${terms})
      ORDER BY rank DESC
      LIMIT ${limit}
    `;
  } catch {
    // Fall back if searchVector column doesn't exist yet
    return [];
  }
}

function mergeWithRRF(
  vectorResults: RawVectorResult[],
  lexicalResults: RawLexicalResult[]
): HybridSearchResult[] {
  const vectorRanks = new Map(vectorResults.map((r, i) => [r.chunkId, { rank: i + 1, result: r }]));
  const lexicalRanks = new Map(lexicalResults.map((r, i) => [r.chunkId, { rank: i + 1, result: r }]));

  const allChunkIds = new Set([
    ...vectorResults.map(r => r.chunkId),
    ...lexicalResults.map(r => r.chunkId),
  ]);

  const merged: HybridSearchResult[] = [];

  for (const chunkId of allChunkIds) {
    const vectorEntry = vectorRanks.get(chunkId);
    const lexicalEntry = lexicalRanks.get(chunkId);

    let rrfScore = 0;
    if (vectorEntry) rrfScore += 1 / (RRF_K + vectorEntry.rank);
    if (lexicalEntry) rrfScore += 1 / (RRF_K + lexicalEntry.rank);

    const base = vectorEntry?.result || lexicalEntry?.result;
    if (!base) continue;

    merged.push({
      chunkId: base.chunkId,
      chunkContent: base.chunkContent,
      chunkIndex: base.chunkIndex,
      isIntro: base.isIntro,
      isSummary: base.isSummary,
      articleId: base.articleId,
      title: base.title,
      summary: base.summary,
      url: base.url,
      source: base.source,
      publishedAt: base.publishedAt,
      vectorScore: vectorEntry?.result.similarity || 0,
      lexicalScore: lexicalEntry?.result.rank || 0,
      rrfScore,
    });
  }

  return merged.sort((a, b) => b.rrfScore - a.rrfScore);
}
