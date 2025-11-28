import { ChatOpenAI } from '@langchain/openai';
import { ChatPromptTemplate } from '@langchain/core/prompts';
import { RunnableSequence } from '@langchain/core/runnables';
import { CallbackHandler } from '@langfuse/langchain';
import { prisma } from '../utils/db';
import { debugLogger } from '../utils/debug-logger';
import { SingleArticleAnalysisSchema, SingleArticleAnalysis } from '../schemas';
import crypto from 'crypto';
import {
  expandQueryWithLLM,
  cosineSimilarity,
} from '../utils/query-expansion';
import { createOpenRouterEmbeddings, OpenRouterEmbeddings } from './llm';

/**
 * Query-level analysis cache
 * Caches full analysis results keyed by normalized query + timeframe
 * Invalidates when new articles are added
 */
interface CacheEntry {
  output: AnalysisOutput;
  articleCount: number;  // To detect when new articles are added
  timestamp: number;
}

const queryCache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes TTL

function getCacheKey(question: string, daysBack: number): string {
  // Normalize query: lowercase, remove extra spaces, sort words
  const normalized = question.toLowerCase().trim().replace(/\s+/g, ' ');
  const hash = crypto.createHash('md5').update(`${normalized}:${daysBack}`).digest('hex');
  return hash;
}

async function getCachedAnalysis(
  question: string,
  daysBack: number
): Promise<AnalysisOutput | null> {
  const key = getCacheKey(question, daysBack);
  const cached = queryCache.get(key);

  if (!cached) {
    return null;
  }

  // Check TTL
  if (Date.now() - cached.timestamp > CACHE_TTL_MS) {
    queryCache.delete(key);
    return null;
  }

  // Check if new articles have been added
  const dateFilter = new Date();
  dateFilter.setDate(dateFilter.getDate() - daysBack);
  const currentCount = await prisma.article.count({
    where: { publishedAt: { gte: dateFilter } },
  });

  if (currentCount !== cached.articleCount) {
    queryCache.delete(key);
    debugLogger.info('AGENT_ANALYSIS', 'Cache invalidated due to new articles', {
      cachedCount: cached.articleCount,
      currentCount,
    });
    return null;
  }

  debugLogger.info('AGENT_ANALYSIS', 'Query cache hit', { key, question });
  return cached.output;
}

function setCachedAnalysis(
  question: string,
  daysBack: number,
  output: AnalysisOutput,
  articleCount: number
): void {
  const key = getCacheKey(question, daysBack);
  queryCache.set(key, {
    output,
    articleCount,
    timestamp: Date.now(),
  });
  debugLogger.info('AGENT_ANALYSIS', 'Query cached', { key, question, articleCount });
}

/**
 * Reduce phase cache - caches LLM summary based on input data
 * This helps when different questions produce similar sentiment/insights
 */
interface ReduceCacheEntry {
  summary: string;
  timestamp: number;
}

const reduceCache = new Map<string, ReduceCacheEntry>();
const REDUCE_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes TTL

function getReduceCacheKey(
  bullishPercent: number,
  bearishPercent: number,
  insightsSummary: string,
  question: string
): string {
  // Round percentages to reduce cache fragmentation
  const roundedBullish = Math.round(bullishPercent / 10) * 10;
  const roundedBearish = Math.round(bearishPercent / 10) * 10;
  // Include question hash for specificity
  const questionHash = crypto.createHash('md5').update(question).digest('hex').substring(0, 8);
  const insightsHash = crypto.createHash('md5').update(insightsSummary).digest('hex').substring(0, 16);
  return `reduce:${roundedBullish}:${roundedBearish}:${insightsHash}:${questionHash}`;
}

function getCachedReduce(key: string): string | null {
  const cached = reduceCache.get(key);
  if (!cached) return null;
  if (Date.now() - cached.timestamp > REDUCE_CACHE_TTL_MS) {
    reduceCache.delete(key);
    return null;
  }
  debugLogger.info('AGENT_ANALYSIS', 'Reduce cache hit', { key });
  return cached.summary;
}

function setCachedReduce(key: string, summary: string): void {
  reduceCache.set(key, { summary, timestamp: Date.now() });
  debugLogger.info('AGENT_ANALYSIS', 'Reduce output cached', { key });
}

/**
 * Clear the query cache (called when new articles are ingested)
 */
export function clearAnalysisCache(): void {
  const querySize = queryCache.size;
  const reduceSize = reduceCache.size;
  queryCache.clear();
  reduceCache.clear();
  debugLogger.info('AGENT_ANALYSIS', 'Caches cleared', { queryEntriesCleared: querySize, reduceEntriesCleared: reduceSize });
}

/**
 * Semantic pre-filtering: Find relevant article IDs using LLM query expansion + vector search
 * Uses dynamic LLM-based understanding instead of hardcoded dictionaries
 * @param callbacks - Optional LangFuse callbacks for tracing
 */
interface VectorSearchResult {
  articleId: string;
  similarity: number;
}

async function findRelevantArticleIds(
  question: string,
  daysBack: number,
  embeddings: OpenRouterEmbeddings,
  llm: ChatOpenAI,
  callbacks?: CallbackHandler[]
): Promise<{ articleIds: Set<string>; isTopicSpecific: boolean; searchTerms: string[]; vectorResults: VectorSearchResult[] }> {
  const stepId = debugLogger.stepStart('SEMANTIC_PREFILTER', 'Running semantic pre-filter', {
    question: question.substring(0, 50),
  });

  try {
    // Use LLM to understand the query and generate search terms dynamically
    // Pass callbacks for LangFuse tracing
    const expansion = await expandQueryWithLLM(question, llm, callbacks);

    if (!expansion.isTopicSpecific) {
      debugLogger.stepFinish(stepId, { isTopicSpecific: false, reason: 'LLM determined query is not topic-specific' });
      return { articleIds: new Set(), isTopicSpecific: false, searchTerms: [], vectorResults: [] };
    }

    debugLogger.info('SEMANTIC_PREFILTER', 'LLM expanded query', {
      category: expansion.category,
      searchTerms: expansion.searchTerms,
    });

    const dateFilter = new Date();
    dateFilter.setDate(dateFilter.getDate() - daysBack);

    // Create a combined search query from LLM-generated terms
    const searchQuery = expansion.searchTerms.join(' ');

    // Get embedding for the search query
    const queryEmbedding = await embeddings.embedQuery(searchQuery);
    const embeddingStr = `[${queryEmbedding.join(',')}]`;

    // Vector search for relevant chunks
    const vectorResults = await prisma.$queryRaw<Array<{ articleId: string; similarity: number }>>`
      SELECT DISTINCT
        a.id as "articleId",
        MAX(1 - (e.embedding <=> ${embeddingStr}::vector)) as similarity
      FROM "ArticleEmbedding" e
      JOIN "ArticleChunk" c ON e."chunkId" = c.id
      JOIN "Article" a ON c."articleId" = a.id
      WHERE a."publishedAt" >= ${dateFilter}
        AND (1 - (e.embedding <=> ${embeddingStr}::vector)) >= 0.35
      GROUP BY a.id
      ORDER BY similarity DESC
      LIMIT 50
    `;

    // Also do lexical search on article titles for LLM-generated search terms
    const lexicalConditions = expansion.searchTerms.slice(0, 5).map((term: string) => ({
      title: { contains: term, mode: 'insensitive' as const },
    }));

    const lexicalResults = await prisma.article.findMany({
      where: {
        publishedAt: { gte: dateFilter },
        OR: lexicalConditions.length > 0 ? lexicalConditions : undefined,
      },
      select: { id: true },
      take: 30,
    });

    // Merge results
    const articleIds = new Set<string>([
      ...vectorResults.map(r => r.articleId),
      ...lexicalResults.map(r => r.id),
    ]);

    debugLogger.stepFinish(stepId, {
      vectorResults: vectorResults.length,
      lexicalResults: lexicalResults.length,
      uniqueArticles: articleIds.size,
      topSimilarity: vectorResults[0]?.similarity?.toFixed(3),
      searchTerms: expansion.searchTerms.slice(0, 5),
    });

    return { articleIds, isTopicSpecific: true, searchTerms: expansion.searchTerms, vectorResults };
  } catch (error) {
    debugLogger.stepError(stepId, 'SEMANTIC_PREFILTER', 'Semantic pre-filter failed', error);
    return { articleIds: new Set(), isTopicSpecific: false, searchTerms: [], vectorResults: [] };
  }
}

/**
 * Check if a query result is cached (for early cache check before moderation)
 * Returns the cached output if valid, null otherwise
 */
export async function checkAnalysisCacheOnly(
  question: string,
  daysBack: number
): Promise<AnalysisOutput | null> {
  return getCachedAnalysis(question, daysBack);
}

export interface ArticleInsight {
  id: string;
  title: string;
  url: string;
  publishedAt: Date;
  sentiment: 'bullish' | 'bearish' | 'neutral';
  keyPoints: string[];
  entities: string[];
  fromCache: boolean;
  titleEmbedding: number[] | null;  // Cached title embedding for fast semantic ranking
}

export interface AnalysisSource {
  title: string;
  url: string;
  publishedAt: string;
  quote: string;
  relevance: number;
}

export interface AnalysisRetrievalMetrics {
  articlesRetrievedByVector: number;
  articlesUsedInResponse: number;
  topVectorScore: number;
  avgVectorScore: number;
}

export interface AnalysisOutput {
  summary: string;
  sentiment: {
    overall: 'bullish' | 'bearish' | 'neutral' | 'mixed';
    bullishPercent: number;
    bearishPercent: number;
  };
  trends: string[];
  prediction?: string;
  articlesAnalyzed: number;
  cachedInsights: number;
  newInsights: number;
  timeframeDays: number;
  disclaimer: string;
  confidence: number;
  topSources: AnalysisSource[];
  citationCount: number;  // Number of [Source N] citations in summary
  retrievalMetrics?: AnalysisRetrievalMetrics;
}

export type ProgressCallback = (progress: {
  phase: 'fetching' | 'analyzing' | 'summarizing';
  current: number;
  total: number;
  cached: number;
}) => void;

export type TokenStreamCallback = (token: string) => void;

const DISCLAIMER = '⚠️ This analysis is based on news coverage and does not constitute financial advice. Past trends do not guarantee future results.';

/**
 * Count unique [Source N] citations in text
 */
function countCitations(text: string): number {
  const citationRegex = /\[Source (\d+)\]/g;
  const citations = new Set<number>();
  let match;
  while ((match = citationRegex.exec(text)) !== null) {
    citations.add(parseInt(match[1], 10));
  }
  return citations.size;
}

// SingleArticleAnalysis type is imported from ../schemas

const MAP_PROMPT = `Analyze this crypto news article and extract:
1. Sentiment: bullish, bearish, or neutral
2. Key points (2-3 bullet points)
3. Mentioned entities (cryptocurrencies, companies, people)

Article:
Title: {title}
Content: {content}`;

const REDUCE_PROMPT = `Based on analysis of {count} crypto news articles from the last {days} days:

Sentiment: {bullishPercent}% bullish, {bearishPercent}% bearish, {neutralPercent}% neutral

=== CITABLE SOURCES (use [Source N] format) ===
{sourcesForCitation}

=== CONTEXT ===
{insights}

User Question: {question}

CITATION RULES:
- Use [Source N] format only (e.g., [Source 1], [Source 3])
- Every claim needs a citation
- NO other formats like [BULLISH] or article titles in brackets

RESPONSE FORMAT (be concise - aim for 150-200 words max):

**Summary**: 2-3 sentences directly answering the question with key facts [Source N].

**What's happening**: 3-5 bullet points of the most important news [Source N].

**Why it matters**: 1-2 sentences on the broader implications.

**What to watch**: 1-2 sentences on upcoming catalysts or risks.

Keep it short and factual. No fluff or repetition.`;

interface ArticleWithInsights {
  id: string;
  title: string;
  summary: string | null;
  content: string;
  url: string;
  publishedAt: Date;
  sentiment: string | null;
  keyPoints: string[];
  entities: string[];
  analyzedAt: Date | null;
  titleEmbedding: number[] | null;  // Cached title embedding for fast semantic ranking
}

/**
 * Fetch articles with their cached insights and title embeddings
 * @param daysBack - Number of days to look back
 * @param relevantIds - Optional set of article IDs to filter to (for topic-specific queries)
 */
async function fetchArticlesWithInsights(
  daysBack: number,
  relevantIds?: Set<string>
): Promise<ArticleWithInsights[]> {
  const dateFilter = new Date();
  dateFilter.setDate(dateFilter.getDate() - daysBack);

  // Use raw SQL to fetch titleEmbedding (Prisma doesn't support vector type directly)
  // Cast vector to text array format for parsing
  let results: ArticleWithInsights[];

  if (relevantIds && relevantIds.size > 0) {
    const idArray = Array.from(relevantIds);
    results = await prisma.$queryRaw<ArticleWithInsights[]>`
      SELECT
        id, title, summary, content, url, "publishedAt", sentiment,
        "keyPoints", entities, "analyzedAt",
        "titleEmbedding"::text as "titleEmbeddingText"
      FROM "Article"
      WHERE "publishedAt" >= ${dateFilter}
        AND id = ANY(${idArray}::text[])
      ORDER BY "publishedAt" DESC
    `;
  } else {
    results = await prisma.$queryRaw<ArticleWithInsights[]>`
      SELECT
        id, title, summary, content, url, "publishedAt", sentiment,
        "keyPoints", entities, "analyzedAt",
        "titleEmbedding"::text as "titleEmbeddingText"
      FROM "Article"
      WHERE "publishedAt" >= ${dateFilter}
      ORDER BY "publishedAt" DESC
    `;
  }

  // Parse titleEmbedding from text format "[0.1,0.2,...]" to number[]
  return results.map(r => ({
    ...r,
    titleEmbedding: parseTitleEmbedding((r as unknown as { titleEmbeddingText: string | null }).titleEmbeddingText),
  }));
}

/**
 * Parse title embedding from PostgreSQL vector text format to number array
 */
function parseTitleEmbedding(text: string | null): number[] | null {
  if (!text) return null;
  try {
    // Format is "[0.1,0.2,0.3,...]"
    const cleaned = text.replace(/^\[|\]$/g, '');
    return cleaned.split(',').map(Number);
  } catch {
    return null;
  }
}

/**
 * Check if cached insight exists
 * Article content doesn't change, so insights are valid forever once computed
 */
function isCacheValid(analyzedAt: Date | null): boolean {
  // If we have analyzedAt, the article has been analyzed - insights are permanent
  return analyzedAt !== null;
}

/**
 * Map phase: Extract insights from articles (with caching)
 */
async function mapArticles(
  articles: ArticleWithInsights[],
  llm: ChatOpenAI,
  callbacks: CallbackHandler[],
  onProgress?: ProgressCallback
): Promise<ArticleInsight[]> {
  const batchSize = 20; // Increased for faster processing
  const insights: ArticleInsight[] = [];
  const articlesToAnalyze: ArticleWithInsights[] = [];
  let cachedCount = 0;

  // Separate cached vs uncached articles
  for (const article of articles) {
    if (isCacheValid(article.analyzedAt) && article.sentiment) {
      insights.push({
        id: article.id,
        title: article.title,
        url: article.url,
        publishedAt: article.publishedAt,
        sentiment: article.sentiment as 'bullish' | 'bearish' | 'neutral',
        keyPoints: article.keyPoints,
        entities: article.entities,
        fromCache: true,
        titleEmbedding: article.titleEmbedding,  // Pass through cached embedding
      });
      cachedCount++;
    } else {
      articlesToAnalyze.push(article);
    }
  }

  debugLogger.info('AGENT_ANALYSIS', 'Cache status', {
    total: articles.length,
    cached: cachedCount,
    toAnalyze: articlesToAnalyze.length,
  });

  // Process uncached articles in batches
  for (let i = 0; i < articlesToAnalyze.length; i += batchSize) {
    const batch = articlesToAnalyze.slice(i, i + batchSize);

    onProgress?.({
      phase: 'analyzing',
      current: cachedCount + i,
      total: articles.length,
      cached: cachedCount,
    });

    const batchResults = await Promise.all(
      batch.map(async (article) => {
        try {
          const content = article.summary || article.content.substring(0, 1500);

          // Use chain pattern with structured output for reliable parsing
          // CRITICAL: Use withStructuredOutput for consistent schema-based responses
          const structuredLLM = llm.withStructuredOutput<SingleArticleAnalysis>(SingleArticleAnalysisSchema);
          const mapPrompt = ChatPromptTemplate.fromTemplate(MAP_PROMPT);
          const chain = RunnableSequence.from([mapPrompt, structuredLLM]);
          const parsed = await chain.invoke(
            { title: article.title, content },
            { callbacks, runName: `Analyze: ${article.title.substring(0, 30)}` }
          );

          const insight: ArticleInsight = {
            id: article.id,
            title: article.title,
            url: article.url,
            publishedAt: article.publishedAt,
            sentiment: parsed.sentiment || 'neutral',
            keyPoints: parsed.keyPoints || [],
            entities: parsed.entities || [],
            fromCache: false,
            titleEmbedding: article.titleEmbedding,  // Pass through cached embedding
          };

          // Cache the insight in database (fire and forget)
          prisma.article.update({
            where: { id: article.id },
            data: {
              sentiment: insight.sentiment,
              keyPoints: insight.keyPoints,
              entities: insight.entities,
              analyzedAt: new Date(),
            },
          }).catch((err) => {
            debugLogger.warn('AGENT_ANALYSIS', 'Failed to cache insight', { articleId: article.id, error: err.message });
          });

          return insight;
        } catch (err) {
          debugLogger.warn('AGENT_ANALYSIS', 'Failed to analyze article', { title: article.title, error: err });
          return {
            id: article.id,
            title: article.title,
            url: article.url,
            publishedAt: article.publishedAt,
            sentiment: 'neutral' as const,
            keyPoints: [],
            entities: [],
            fromCache: false,
            titleEmbedding: article.titleEmbedding,  // Pass through cached embedding
          };
        }
      })
    );

    insights.push(...batchResults);
  }

  return insights;
}

/**
 * Select top articles using semantic ranking
 * Uses CACHED title embeddings from database - no API calls needed!
 * Falls back to batch embedding only for articles without cached embeddings
 */
async function selectTopSourcesSemantic(
  insights: ArticleInsight[],
  query: string,
  searchTerms: string[],
  queryEmbedding: number[],
  embeddings: OpenRouterEmbeddings,
  limit: number
): Promise<AnalysisSource[]> {
  const now = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;

  // Filter to articles with key points, limit to 50 for efficiency
  const candidateInsights = insights.filter(i => i.keyPoints.length > 0).slice(0, 50);

  // Count cached vs uncached embeddings
  const withCachedEmb = candidateInsights.filter(i => i.titleEmbedding !== null);
  const withoutCachedEmb = candidateInsights.filter(i => i.titleEmbedding === null);

  debugLogger.info('AGENT_ANALYSIS', 'Selecting top sources with semantic ranking', {
    originalQuery: query.substring(0, 50),
    searchTermsCount: searchTerms.length,
    candidateCount: candidateInsights.length,
    cachedEmbeddings: withCachedEmb.length,
    needsEmbedding: withoutCachedEmb.length,
  });

  // Create a set of search terms for quick lookup (lowercase)
  const searchTermSet = new Set(searchTerms.map(t => t.toLowerCase()));

  // Build titleEmbeddings map from cached embeddings (zero API calls for these!)
  const titleEmbeddings = new Map<string, number[]>();
  for (const insight of withCachedEmb) {
    if (insight.titleEmbedding) {
      titleEmbeddings.set(insight.id, insight.titleEmbedding);
    }
  }

  // Only generate embeddings for articles that don't have cached ones (should be rare after backfill)
  if (withoutCachedEmb.length > 0) {
    debugLogger.info('AGENT_ANALYSIS', 'Generating embeddings for uncached titles', {
      count: withoutCachedEmb.length,
    });

    // Use batch embedding for efficiency - ONE API call for all titles
    const titlesToEmbed = withoutCachedEmb.map(i => i.title);
    try {
      const batchEmbeddings = await embeddings.embedDocuments(titlesToEmbed);
      for (let i = 0; i < withoutCachedEmb.length; i++) {
        titleEmbeddings.set(withoutCachedEmb[i].id, batchEmbeddings[i]);
      }
    } catch (err) {
      debugLogger.warn('AGENT_ANALYSIS', 'Batch embedding failed for uncached titles', { error: err });
    }
  }

  // Score each article
  const scored = candidateInsights
    .map(insight => {
      let source = 'unknown';
      try { source = new URL(insight.url).hostname.replace('www.', ''); } catch {}

      // === SEMANTIC TITLE SIMILARITY (0-0.5) - Highest weight ===
      const titleEmb = titleEmbeddings.get(insight.id);
      const semanticScore = titleEmb ? cosineSimilarity(queryEmbedding, titleEmb) * 0.5 : 0;

      // === SEARCH TERM MATCH (0-0.25) - Check if title/entities contain LLM search terms ===
      const titleLower = insight.title.toLowerCase();
      const entitiesLower = insight.entities.map(e => e.toLowerCase());
      let termMatchScore = 0;
      let matchedTerms = 0;

      for (const term of searchTermSet) {
        if (titleLower.includes(term)) {
          matchedTerms++;
        }
        for (const entity of entitiesLower) {
          if (entity.includes(term) || term.includes(entity)) {
            matchedTerms++;
            break;
          }
        }
      }
      termMatchScore = Math.min(matchedTerms / 3, 1) * 0.25;

      // === KEY POINTS SCORE (0-0.1) ===
      const keyPointsScore = Math.min(insight.keyPoints.length / 5, 1) * 0.1;

      // === RECENCY (0-0.1) - decay over 7 days ===
      const age = (now - new Date(insight.publishedAt).getTime()) / dayMs;
      const recencyScore = Math.max(0, 1 - age / 7) * 0.1;

      // === SENTIMENT BONUS (0-0.05) ===
      const sentimentScore = insight.sentiment !== 'neutral' ? 0.05 : 0;

      const totalScore = semanticScore + termMatchScore + keyPointsScore + recencyScore + sentimentScore;

      return {
        insight,
        source,
        score: totalScore,
        semanticScore,
        termMatchScore,
      };
    })
    .sort((a, b) => b.score - a.score);

  // Log top scoring articles for debugging
  const topScored = scored.slice(0, 5);
  debugLogger.info('AGENT_ANALYSIS', 'Top scored articles (semantic)', {
    topArticles: topScored.map(s => ({
      title: s.insight.title.substring(0, 50),
      score: s.score.toFixed(3),
      semantic: s.semanticScore.toFixed(3),
      termMatch: s.termMatchScore.toFixed(3),
    })),
  });

  // Deduplicate by title
  const seenTitles = new Set<string>();
  const deduplicated = scored.filter(item => {
    const normalizedTitle = item.insight.title.toLowerCase().trim();
    if (seenTitles.has(normalizedTitle)) {
      return false;
    }
    seenTitles.add(normalizedTitle);
    return true;
  });

  // Return top articles by score
  return deduplicated.slice(0, limit).map(({ insight, score }) => ({
    title: insight.title,
    url: insight.url,
    publishedAt: insight.publishedAt.toISOString(),
    quote: insight.keyPoints[0] || '',
    relevance: Math.round(score * 100) / 100,
  }));
}

/**
 * Fallback source selection for non-topic-specific queries
 * Uses basic scoring without semantic matching
 */
function selectTopSourcesBasic(insights: ArticleInsight[], limit: number): AnalysisSource[] {
  const now = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;

  const scored = insights
    .filter(i => i.keyPoints.length > 0)
    .map(insight => {
      // Key points score (0-0.4)
      const keyPointsScore = Math.min(insight.keyPoints.length / 5, 1) * 0.4;

      // Recency (0-0.4) - decay over 7 days
      const age = (now - new Date(insight.publishedAt).getTime()) / dayMs;
      const recencyScore = Math.max(0, 1 - age / 7) * 0.4;

      // Sentiment bonus (0-0.2)
      const sentimentScore = insight.sentiment !== 'neutral' ? 0.2 : 0;

      return {
        insight,
        score: keyPointsScore + recencyScore + sentimentScore,
      };
    })
    .sort((a, b) => b.score - a.score);

  // Deduplicate by title
  const seenTitles = new Set<string>();
  const deduplicated = scored.filter(item => {
    const normalizedTitle = item.insight.title.toLowerCase().trim();
    if (seenTitles.has(normalizedTitle)) {
      return false;
    }
    seenTitles.add(normalizedTitle);
    return true;
  });

  return deduplicated.slice(0, limit).map(({ insight, score }) => ({
    title: insight.title,
    url: insight.url,
    publishedAt: insight.publishedAt.toISOString(),
    quote: insight.keyPoints[0] || '',
    relevance: Math.round(score * 100) / 100,
  }));
}

/**
 * Reduce phase: Aggregate insights into final analysis
 * Uses semantic source selection when search terms and embeddings are provided
 */
async function reduceInsights(
  insights: ArticleInsight[],
  question: string,
  daysBack: number,
  llm: ChatOpenAI,
  callbacks: CallbackHandler[],
  onToken?: TokenStreamCallback,
  semanticContext?: {
    searchTerms: string[];
    queryEmbedding: number[];
    embeddings: OpenRouterEmbeddings;
  }
): Promise<AnalysisOutput> {
  // Calculate sentiment breakdown
  const sentimentCounts = { bullish: 0, bearish: 0, neutral: 0 };
  for (const insight of insights) {
    sentimentCounts[insight.sentiment]++;
  }

  const total = insights.length || 1;
  const bullishPercent = Math.round((sentimentCounts.bullish / total) * 100);
  const bearishPercent = Math.round((sentimentCounts.bearish / total) * 100);
  const neutralPercent = 100 - bullishPercent - bearishPercent;

  let overallSentiment: 'bullish' | 'bearish' | 'neutral' | 'mixed';
  if (bullishPercent > 60) overallSentiment = 'bullish';
  else if (bearishPercent > 60) overallSentiment = 'bearish';
  else if (Math.abs(bullishPercent - bearishPercent) < 20) overallSentiment = 'mixed';
  else overallSentiment = 'neutral';

  // UNIFIED SOURCE SELECTION
  // Use the SAME sources for: (1) LLM context, (2) citations, (3) frontend display
  // This ensures consistency - the LLM can cite any source it sees
  const SOURCE_LIMIT = 15;  // Single source of truth for all counts

  // Select top sources using semantic ranking if available, otherwise basic ranking
  let topSources: AnalysisSource[];
  if (semanticContext) {
    topSources = await selectTopSourcesSemantic(
      insights,
      question,
      semanticContext.searchTerms,
      semanticContext.queryEmbedding,
      semanticContext.embeddings,
      SOURCE_LIMIT
    );
  } else {
    topSources = selectTopSourcesBasic(insights, SOURCE_LIMIT);
  }

  // Format sources for citation in prompt (numbered list)
  // ALL selected sources get [Source N] numbers - no subset!
  const sourcesForCitation = topSources
    .map((source: AnalysisSource, idx: number) => `[Source ${idx + 1}] "${source.title}" - ${source.quote}`)
    .join('\n');

  // Build insights summary from the SAME sources (not a separate selection)
  // This ensures insights shown to LLM match citable sources
  const insightsSummary = topSources
    .map((source: AnalysisSource) => {
      // Find the original insight for this source to get sentiment/keyPoints
      const insight = insights.find(i => i.title === source.title);
      if (!insight) return null;
      return `- [${insight.sentiment.toUpperCase()}] ${source.title}: ${insight.keyPoints.slice(0, 2).join('; ')}`;
    })
    .filter(Boolean)
    .join('\n');

  debugLogger.info('AGENT_ANALYSIS', 'Prepared unified sources for citation', {
    totalSources: topSources.length,
    citableSources: topSources.length,  // Now ALL sources are citable
  });

  // Check reduce cache before LLM call (saves ~10s for similar queries)
  const reduceCacheKey = getReduceCacheKey(bullishPercent, bearishPercent, insightsSummary, question);
  let summary = getCachedReduce(reduceCacheKey);

  if (!summary) {
    // Use chain pattern to ensure CallbackHandler receives handleChainStart
    // which properly sets sessionId on the trace
    const reducePrompt = ChatPromptTemplate.fromTemplate(REDUCE_PROMPT);
    const reduceChain = reducePrompt.pipe(llm);
    const promptVars = {
      count: String(insights.length),
      days: String(daysBack),
      bullishPercent: String(bullishPercent),
      bearishPercent: String(bearishPercent),
      neutralPercent: String(neutralPercent),
      sourcesForCitation,
      insights: insightsSummary,
      question,
    };

    // Use streaming when callback is provided
    if (onToken) {
      const stream = await reduceChain.stream(promptVars, {
        callbacks,
        runName: 'Analysis: Generate Summary (Streaming)',
      });

      const chunks: string[] = [];
      for await (const chunk of stream) {
        const token = typeof chunk.content === 'string' ? chunk.content : String(chunk.content);
        chunks.push(token);
        onToken(token);
      }
      summary = chunks.join('');
    } else {
      const response = await reduceChain.invoke(promptVars, {
        callbacks,
        runName: 'Analysis: Generate Summary',
      });
      summary = typeof response.content === 'string' ? response.content : String(response.content);
    }

    // Cache the summary for future similar queries
    setCachedReduce(reduceCacheKey, summary);
  } else if (onToken) {
    // If cached, still stream the cached content for consistent UX
    // Stream in small chunks with small delay for natural feel
    const chunkSize = 5; // Stream 5 words at a time
    const words = summary.split(' ');
    for (let i = 0; i < words.length; i += chunkSize) {
      const chunk = words.slice(i, i + chunkSize).join(' ') + ' ';
      onToken(chunk);
      // Small delay to allow SSE to flush to client
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }

  // Extract trends from insights
  const allKeyPoints = insights.flatMap((i) => i.keyPoints);
  const trends = extractTopTrends(allKeyPoints, 5);

  // Calculate confidence based on data quality
  const cachedCount = insights.filter(i => i.fromCache).length;
  const confidence = calculateConfidence(insights, daysBack);

  // topSources was already selected above for citation purposes

  // Count citations in the generated summary
  const citationCount = countCitations(summary);
  debugLogger.info('AGENT_ANALYSIS', 'Citation count in summary', {
    citationCount,
    sourcesAvailable: topSources.length,
  });

  return {
    summary,
    sentiment: {
      overall: overallSentiment,
      bullishPercent,
      bearishPercent,
    },
    trends,
    articlesAnalyzed: insights.length,
    cachedInsights: cachedCount,
    newInsights: insights.length - cachedCount,
    timeframeDays: daysBack,
    disclaimer: DISCLAIMER,
    confidence,
    topSources,
    citationCount,
  };
}

/**
 * Calculate confidence score based on data quality
 */
function calculateConfidence(insights: ArticleInsight[], daysBack: number): number {
  if (insights.length === 0) return 0;

  let score = 50; // Base score

  // More articles = higher confidence (up to +25)
  const articleBonus = Math.min(insights.length / 10, 25);
  score += articleBonus;

  // Recency bonus: articles from last 24h boost confidence (up to +15)
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const recentCount = insights.filter(i => i.publishedAt > oneDayAgo).length;
  const recencyBonus = Math.min((recentCount / insights.length) * 15, 15);
  score += recencyBonus;

  // Sentiment consistency bonus (up to +10)
  const sentimentCounts = { bullish: 0, bearish: 0, neutral: 0 };
  for (const insight of insights) {
    sentimentCounts[insight.sentiment]++;
  }
  const maxSentiment = Math.max(sentimentCounts.bullish, sentimentCounts.bearish, sentimentCounts.neutral);
  const consistencyRatio = maxSentiment / insights.length;
  const consistencyBonus = consistencyRatio * 10;
  score += consistencyBonus;

  return Math.min(Math.round(score), 100);
}

/**
 * Extract top recurring themes from key points
 */
function extractTopTrends(keyPoints: string[], limit: number): string[] {
  const wordFreq = new Map<string, number>();
  const stopWords = new Set(['the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should', 'may', 'might', 'must', 'shall', 'can', 'need', 'dare', 'ought', 'used', 'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from', 'as', 'into', 'through', 'during', 'before', 'after', 'above', 'below', 'between', 'under', 'again', 'further', 'then', 'once', 'and', 'but', 'or', 'nor', 'so', 'yet', 'both', 'either', 'neither', 'not', 'only', 'own', 'same', 'than', 'too', 'very', 'just', 'also', 'crypto', 'cryptocurrency', 'market', 'price', 'trading']);

  for (const point of keyPoints) {
    const words = point.toLowerCase().split(/\W+/).filter(w => w.length > 3 && !stopWords.has(w));
    for (const word of words) {
      wordFreq.set(word, (wordFreq.get(word) || 0) + 1);
    }
  }

  return Array.from(wordFreq.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([word]) => word);
}

/**
 * Analyze a single article during ingestion (pre-analysis)
 * This eliminates cold-start latency by having insights ready when queried
 */
export async function analyzeArticleForIngestion(
  title: string,
  content: string,
  llm: ChatOpenAI
): Promise<SingleArticleAnalysis> {
  try {
    // Use summary if available, otherwise truncate content
    const contentForAnalysis = content.substring(0, 1500);

    // Use structured output for reliable parsing
    const structuredLLM = llm.withStructuredOutput<SingleArticleAnalysis>(SingleArticleAnalysisSchema);
    const mapPrompt = ChatPromptTemplate.fromTemplate(MAP_PROMPT);
    const chain = RunnableSequence.from([mapPrompt, structuredLLM]);
    const parsed = await chain.invoke({
      title,
      content: contentForAnalysis,
    });

    return {
      sentiment: parsed.sentiment || 'neutral',
      keyPoints: parsed.keyPoints || [],
      entities: parsed.entities || [],
    };
  } catch (err) {
    debugLogger.warn('INGESTION_ANALYSIS', 'Failed to pre-analyze article', { title, error: err });
    return {
      sentiment: 'neutral',
      keyPoints: [],
      entities: [],
    };
  }
}

/**
 * Create analysis agent for analytical queries
 * @param llm - The ChatOpenAI instance
 * @param langfuseHandler - LangFuse callback handler for tracing
 */
export async function createAnalysisAgent(
  llm: ChatOpenAI,
  langfuseHandler?: CallbackHandler
): Promise<(question: string, daysBack: number, onProgress?: ProgressCallback, onToken?: TokenStreamCallback) => Promise<AnalysisOutput>> {
  // Create callbacks array from handler
  const callbacks: CallbackHandler[] = langfuseHandler ? [langfuseHandler] : [];

  return async (question: string, daysBack: number, onProgress?: ProgressCallback, onToken?: TokenStreamCallback): Promise<AnalysisOutput> => {
    const stepId = debugLogger.stepStart('AGENT_ANALYSIS', 'Analysis agent executing', {
      question,
      daysBack,
    });

    try {
      // Check query-level cache first
      const cachedOutput = await getCachedAnalysis(question, daysBack);
      if (cachedOutput) {
        // Stream cached content for consistent UX
        if (onToken) {
          const chunkSize = 5;
          const words = cachedOutput.summary.split(' ');
          for (let i = 0; i < words.length; i += chunkSize) {
            const chunk = words.slice(i, i + chunkSize).join(' ') + ' ';
            onToken(chunk);
            await new Promise(resolve => setTimeout(resolve, 10));
          }
        }
        debugLogger.stepFinish(stepId, {
          cacheStatus: 'FULL_QUERY_CACHE_HIT',
          queryCacheHit: true,
          articlesAnalyzed: cachedOutput.articlesAnalyzed,
          cachedInsights: cachedOutput.cachedInsights,
          llmCallsSkipped: 'ALL (reduce + map phases)',
          estimatedCostSaved: 'Full analysis cost (~$0.01-0.05)',
        });
        debugLogger.info('AGENT_ANALYSIS', '✅ CACHE EFFICIENCY: Full query cache hit - zero LLM calls needed', {
          question: question.substring(0, 50),
          articlesCount: cachedOutput.articlesAnalyzed,
        });
        return cachedOutput;
      }

      // SEMANTIC PRE-FILTERING: Find relevant articles using LLM query expansion
      // Uses dynamic LLM understanding instead of hardcoded dictionaries
      onProgress?.({ phase: 'fetching', current: 0, total: 0, cached: 0 });
      const embeddings = createOpenRouterEmbeddings();
      const { articleIds: relevantIds, isTopicSpecific, searchTerms, vectorResults } = await findRelevantArticleIds(
        question,
        daysBack,
        embeddings,
        llm,
        callbacks  // Pass callbacks for LangFuse tracing
      );

      // Create query embedding for semantic source ranking
      let queryEmbedding: number[] = [];
      if (isTopicSpecific && searchTerms.length > 0) {
        const searchQuery = searchTerms.join(' ');
        queryEmbedding = await embeddings.embedQuery(searchQuery);
      }

      // Fetch articles - filtered if topic-specific, all otherwise
      debugLogger.info('AGENT_ANALYSIS', 'Fetching articles with cached insights', {
        daysBack,
        isTopicSpecific,
        relevantIdsCount: relevantIds.size,
        searchTerms: searchTerms.slice(0, 5),
      });

      const articles = await fetchArticlesWithInsights(
        daysBack,
        isTopicSpecific && relevantIds.size > 0 ? relevantIds : undefined
      );

      if (articles.length === 0) {
        debugLogger.warn('AGENT_ANALYSIS', 'No articles found');
        const noArticlesMsg = isTopicSpecific
          ? `No articles found about this topic in the last ${daysBack} days.`
          : `No articles found in the last ${daysBack} days to analyze.`;
        return {
          summary: noArticlesMsg,
          sentiment: { overall: 'neutral', bullishPercent: 0, bearishPercent: 0 },
          trends: [],
          articlesAnalyzed: 0,
          cachedInsights: 0,
          newInsights: 0,
          timeframeDays: daysBack,
          disclaimer: DISCLAIMER,
          confidence: 0,
          topSources: [],
          citationCount: 0,
        };
      }

      debugLogger.info('AGENT_ANALYSIS', 'Articles fetched for analysis', {
        totalArticles: articles.length,
        isTopicFiltered: isTopicSpecific && relevantIds.size > 0,
        sampleTitles: articles.slice(0, 3).map(a => a.title.substring(0, 50)),
      });

      // Map: Extract insights from each article (with caching)
      debugLogger.info('AGENT_ANALYSIS', `Processing ${articles.length} articles`);
      const insights = await mapArticles(articles, llm, callbacks, onProgress);

      // Reduce: Aggregate into final analysis with semantic context
      onProgress?.({ phase: 'summarizing', current: articles.length, total: articles.length, cached: insights.filter(i => i.fromCache).length });
      debugLogger.info('AGENT_ANALYSIS', 'Generating analysis summary');

      // Pass semantic context for intelligent source ranking
      const semanticContext = isTopicSpecific && searchTerms.length > 0
        ? { searchTerms, queryEmbedding, embeddings }
        : undefined;

      const output = await reduceInsights(insights, question, daysBack, llm, callbacks, onToken, semanticContext);

      // Calculate retrieval metrics from vector search results
      const vectorScores = vectorResults.map(r => r.similarity).filter(s => s > 0);
      const retrievalMetrics: AnalysisRetrievalMetrics = {
        articlesRetrievedByVector: vectorResults.length,
        articlesUsedInResponse: output.topSources.length,
        topVectorScore: vectorScores.length > 0 ? Math.max(...vectorScores) : 0,
        avgVectorScore: vectorScores.length > 0 ? vectorScores.reduce((a, b) => a + b, 0) / vectorScores.length : 0,
      };
      output.retrievalMetrics = retrievalMetrics;

      // Cache the output for future identical queries
      setCachedAnalysis(question, daysBack, output, articles.length);

      // Calculate cache efficiency metrics
      const cacheHitRate = output.articlesAnalyzed > 0
        ? Math.round((output.cachedInsights / output.articlesAnalyzed) * 100)
        : 0;
      const llmCallsMade = output.newInsights + 1; // +1 for reduce phase
      const llmCallsSkipped = output.cachedInsights;

      debugLogger.stepFinish(stepId, {
        cacheStatus: output.cachedInsights === output.articlesAnalyzed ? 'ALL_INSIGHTS_CACHED' : 'PARTIAL_CACHE',
        articlesAnalyzed: output.articlesAnalyzed,
        cachedInsights: output.cachedInsights,
        newInsights: output.newInsights,
        cacheHitRate: `${cacheHitRate}%`,
        llmCallsMade,
        llmCallsSkipped,
        sentiment: output.sentiment.overall,
        confidence: output.confidence,
        citationCount: output.citationCount,
        queryCached: true,
      });

      debugLogger.info('AGENT_ANALYSIS', `✅ CACHE EFFICIENCY: ${cacheHitRate}% of article insights from cache`, {
        totalArticles: output.articlesAnalyzed,
        fromCache: output.cachedInsights,
        newLLMCalls: output.newInsights,
        reduceLLMCall: output.cachedInsights === output.articlesAnalyzed ? 'Made (not cached)' : 'Made',
      });

      return output;
    } catch (error) {
      debugLogger.stepError(stepId, 'AGENT_ANALYSIS', 'Error in analysis agent', error);
      throw error;
    }
  };
}
