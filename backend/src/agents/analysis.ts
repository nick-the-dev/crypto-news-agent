import { ChatOpenAI } from '@langchain/openai';
import { ChatPromptTemplate } from '@langchain/core/prompts';
import { CallbackHandler } from '@langfuse/langchain';
import { prisma } from '../utils/db';
import { debugLogger } from '../utils/debug-logger';
import crypto from 'crypto';

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
}

export interface AnalysisSource {
  title: string;
  url: string;
  publishedAt: string;
  quote: string;
  relevance: number;
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

/**
 * Single article analysis result (for pre-analysis during ingestion)
 */
export interface SingleArticleAnalysis {
  sentiment: 'bullish' | 'bearish' | 'neutral';
  keyPoints: string[];
  entities: string[];
}

const MAP_PROMPT = `Analyze this crypto news article and extract:
1. Sentiment: bullish, bearish, or neutral
2. Key points (2-3 bullet points)
3. Mentioned entities (cryptocurrencies, companies, people)

Article:
Title: {title}
Content: {content}

Return JSON only: {"sentiment": "bullish"|"bearish"|"neutral", "keyPoints": ["..."], "entities": ["..."]}`;

const REDUCE_PROMPT = `Based on analysis of {count} crypto news articles from the last {days} days:

Sentiment Distribution:
- Bullish: {bullishPercent}%
- Bearish: {bearishPercent}%
- Neutral: {neutralPercent}%

Top Sources (cite these using [Source N] format):
{sourcesForCitation}

Top Article Insights:
{insights}

User Question: {question}

CRITICAL INSTRUCTIONS:
1. Carefully examine the article TITLES and entities in the insights above
2. If the user asked about a specific cryptocurrency (e.g., "XRP", "Bitcoin", "Ethereum"), PRIORITIZE information about that asset
3. Look for mentions in both the titles AND the key points - the title alone is sufficient evidence of relevance
4. If articles mention the queried asset in their titles but not in key points, acknowledge and analyze those articles
5. NEVER claim an asset wasn't mentioned if it appears in article titles or entities

CITATION REQUIREMENTS:
- You MUST cite sources using [Source N] format where N matches the source number above
- Every factual claim should have at least one citation
- Use the source that best supports each claim
- Include multiple citations for well-supported points (e.g., [Source 1][Source 3])

Provide a comprehensive analysis including:
1. Direct response to the user's question with specific information about queried assets [cite sources]
2. Overall market sentiment assessment for the queried asset (if applicable) [cite sources]
3. Key trends identified across relevant articles [cite sources]
4. Notable entities and events related to the query [cite sources]
5. A balanced outlook with appropriate caveats

Format your response as a well-structured analysis that directly addresses the user's question.`;

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
}

/**
 * Fetch articles with their cached insights
 */
async function fetchArticlesWithInsights(daysBack: number): Promise<ArticleWithInsights[]> {
  const dateFilter = new Date();
  dateFilter.setDate(dateFilter.getDate() - daysBack);

  return prisma.article.findMany({
    where: {
      publishedAt: { gte: dateFilter },
    },
    select: {
      id: true,
      title: true,
      summary: true,
      content: true,
      url: true,
      publishedAt: true,
      sentiment: true,
      keyPoints: true,
      entities: true,
      analyzedAt: true,
    },
    orderBy: { publishedAt: 'desc' },
  });
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

          // Use chain pattern to ensure CallbackHandler receives handleChainStart
          // which properly sets sessionId on the trace
          const mapPrompt = ChatPromptTemplate.fromTemplate(MAP_PROMPT);
          const chain = mapPrompt.pipe(llm);
          const response = await chain.invoke(
            { title: article.title, content },
            { callbacks, runName: `Analyze: ${article.title.substring(0, 30)}` }
          );

          const text = typeof response.content === 'string' ? response.content : String(response.content);
          const parsed = JSON.parse(text.replace(/```json?\n?|\n?```/g, '').trim());

          const insight: ArticleInsight = {
            id: article.id,
            title: article.title,
            url: article.url,
            publishedAt: article.publishedAt,
            sentiment: parsed.sentiment || 'neutral',
            keyPoints: parsed.keyPoints || [],
            entities: parsed.entities || [],
            fromCache: false,
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
          };
        }
      })
    );

    insights.push(...batchResults);
  }

  return insights;
}

/**
 * Select top articles with smart ranking:
 * - Key points count (more = better)
 * - Entity relevance to query
 * - Recency bonus
 * - Sentiment bonus (non-neutral = more interesting)
 */
function selectTopSources(insights: ArticleInsight[], query: string, limit: number): AnalysisSource[] {
  const queryTerms = new Set(query.toLowerCase().split(/\W+/).filter(w => w.length > 2));
  const now = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;

  // Score each article
  const scored = insights
    .filter(i => i.keyPoints.length > 0)
    .map(insight => {
      let source = 'unknown';
      try { source = new URL(insight.url).hostname.replace('www.', ''); } catch {}

      // Key points score (0-0.3)
      const keyPointsScore = Math.min(insight.keyPoints.length / 5, 1) * 0.3;

      // Entity relevance (0-0.35)
      const entityMatches = insight.entities.filter(e =>
        queryTerms.has(e.toLowerCase()) ||
        [...queryTerms].some(t => e.toLowerCase().includes(t))
      ).length;
      const entityScore = Math.min(entityMatches / 3, 1) * 0.35;

      // Recency (0-0.2) - decay over 7 days
      const age = (now - new Date(insight.publishedAt).getTime()) / dayMs;
      const recencyScore = Math.max(0, 1 - age / 7) * 0.2;

      // Sentiment bonus (0-0.15)
      const sentimentScore = insight.sentiment !== 'neutral' ? 0.15 : 0;

      return {
        insight,
        source,
        score: keyPointsScore + entityScore + recencyScore + sentimentScore,
      };
    })
    .sort((a, b) => b.score - a.score);

  // Return top articles by score
  return scored.slice(0, limit).map(({ insight, score }) => ({
    title: insight.title,
    url: insight.url,
    publishedAt: insight.publishedAt.toISOString(),
    quote: insight.keyPoints[0] || '',
    relevance: Math.round(score * 100) / 100,
  }));
}

/**
 * Reduce phase: Aggregate insights into final analysis
 */
async function reduceInsights(
  insights: ArticleInsight[],
  question: string,
  daysBack: number,
  llm: ChatOpenAI,
  callbacks: CallbackHandler[],
  onToken?: TokenStreamCallback
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

  // Extract keywords from question for filtering
  const questionKeywords = question
    .toLowerCase()
    .split(/\W+/)
    .filter(w => w.length >= 2 && !['what', 'when', 'where', 'about', 'from', 'last', 'give', 'tell', 'show', 'the', 'and', 'for', 'are', 'was'].includes(w));

  // Score insights by relevance to question
  const scoredInsights = insights.map(insight => {
    let score = 0;
    const titleLower = insight.title.toLowerCase();
    const keyPointsText = insight.keyPoints.join(' ').toLowerCase();
    const entitiesText = insight.entities.join(' ').toLowerCase();

    for (const keyword of questionKeywords) {
      if (titleLower.includes(keyword)) score += 3;
      if (keyPointsText.includes(keyword)) score += 2;
      if (entitiesText.includes(keyword)) score += 1;
    }

    return { insight, score };
  });

  // Sort by relevance score (desc), then take top 50 most relevant
  const relevantInsights = scoredInsights
    .sort((a, b) => b.score - a.score)
    .slice(0, 50)
    .map(si => si.insight);

  // Format insights for reduce prompt
  const insightsSummary = relevantInsights
    .slice(0, 25)
    .map((i) => `- [${i.sentiment.toUpperCase()}] ${i.title}: ${i.keyPoints.slice(0, 2).join('; ')}`)
    .join('\n');

  // Select top sources BEFORE generating summary so they can be cited
  const topSources = selectTopSources(insights, question, 20);

  // Format sources for citation in prompt (numbered list)
  const sourcesForCitation = topSources
    .slice(0, 10)  // Limit to top 10 for citation
    .map((source, idx) => `[Source ${idx + 1}] "${source.title}" - ${source.quote}`)
    .join('\n');

  debugLogger.info('AGENT_ANALYSIS', 'Prepared sources for citation', {
    totalSources: topSources.length,
    sourcesForCitation: topSources.slice(0, 10).length,
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
    const prompt = MAP_PROMPT
      .replace('{title}', title)
      .replace('{content}', contentForAnalysis);

    const response = await llm.invoke(prompt);
    const text = typeof response.content === 'string' ? response.content : String(response.content);
    const parsed = JSON.parse(text.replace(/```json?\n?|\n?```/g, '').trim());

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

      // Fetch articles with cached insights
      onProgress?.({ phase: 'fetching', current: 0, total: 0, cached: 0 });
      debugLogger.info('AGENT_ANALYSIS', 'Fetching articles with cached insights', { daysBack });
      const articles = await fetchArticlesWithInsights(daysBack);

      if (articles.length === 0) {
        debugLogger.warn('AGENT_ANALYSIS', 'No articles found');
        return {
          summary: `No articles found in the last ${daysBack} days to analyze.`,
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

      // Map: Extract insights from each article (with caching)
      debugLogger.info('AGENT_ANALYSIS', `Processing ${articles.length} articles`);
      const insights = await mapArticles(articles, llm, callbacks, onProgress);

      // Reduce: Aggregate into final analysis
      onProgress?.({ phase: 'summarizing', current: articles.length, total: articles.length, cached: insights.filter(i => i.fromCache).length });
      debugLogger.info('AGENT_ANALYSIS', 'Generating analysis summary');
      const output = await reduceInsights(insights, question, daysBack, llm, callbacks, onToken);

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
