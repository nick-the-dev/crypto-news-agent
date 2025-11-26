# Multi-Stage RAG Retrieval Pipeline Implementation Plan

## Problem Statement

The current RAG system fails on vocabulary mismatch queries. When users ask "how is crypt doing today?", the system:
1. Embeds "crypt" directly without expansion
2. Vector similarity to "Bitcoin", "cryptocurrency", "Ethereum" is too low
3. Results fall below 0.5 threshold → returns "No relevant articles found"
4. This occurs despite having 50+ crypto articles in the database

**Root Cause:** Pure vector search with no query preprocessing or lexical fallback.

## Solution Architecture

Implement a 4-stage retrieval pipeline:

```
User Query → [1] Query Rewriter → [2] Hybrid Search → [3] Heuristic Reranker → [4] Confidence Assessment
                    ↓                      ↓                    ↓                       ↓
              Normalized Query      Vector + Lexical      Top 5 Results         Answer with Caveat
                  + Variants          (RRF Merge)                              if confidence < 70%
```

### Configuration Decisions
- **Query Rewriting:** Always-on LLM expansion (~100-200ms/query)
- **Hybrid Search:** Vector (pgvector) + Lexical (PostgreSQL tsvector)
- **Reranking:** Heuristic-based (term matching + RRF + recency)
- **Low Confidence:** Provide answer with disclaimer, not clarification questions

## Implementation Steps

### Phase 1: Database Schema (Full-Text Search)

**File:** `backend/prisma/migrations/[timestamp]_add_fulltext_search/migration.sql`

Add tsvector columns and GIN indexes to enable PostgreSQL full-text search:

```sql
-- Add tsvector column to Article
ALTER TABLE "Article" ADD COLUMN "searchVector" tsvector;

-- Populate with weighted content (title=A, summary=B, content=C)
UPDATE "Article"
SET "searchVector" =
  setweight(to_tsvector('english', COALESCE(title, '')), 'A') ||
  setweight(to_tsvector('english', COALESCE(summary, '')), 'B') ||
  setweight(to_tsvector('english', COALESCE(content, '')), 'C');

-- Create GIN index for fast search
CREATE INDEX "Article_searchVector_idx" ON "Article" USING GIN ("searchVector");

-- Add to ArticleChunk for chunk-level search
ALTER TABLE "ArticleChunk" ADD COLUMN "searchVector" tsvector;
UPDATE "ArticleChunk" SET "searchVector" = to_tsvector('english', COALESCE(content, ''));
CREATE INDEX "ArticleChunk_searchVector_idx" ON "ArticleChunk" USING GIN ("searchVector");

-- Auto-update triggers
CREATE FUNCTION update_article_search_vector() RETURNS TRIGGER AS $$
BEGIN
  NEW."searchVector" :=
    setweight(to_tsvector('english', COALESCE(NEW.title, '')), 'A') ||
    setweight(to_tsvector('english', COALESCE(NEW.summary, '')), 'B') ||
    setweight(to_tsvector('english', COALESCE(NEW.content, '')), 'C');
  RETURN NEW;
END; $$ LANGUAGE plpgsql;

CREATE TRIGGER article_search_vector_update
  BEFORE INSERT OR UPDATE ON "Article"
  FOR EACH ROW EXECUTE FUNCTION update_article_search_vector();
```

**File:** `backend/prisma/schema.prisma`

```prisma
model Article {
  // ... existing fields
  searchVector Unsupported("tsvector")?  // NEW
}

model ArticleChunk {
  // ... existing fields
  searchVector Unsupported("tsvector")?  // NEW
}
```

**Run migration:**
```bash
npx prisma migrate dev --name add_fulltext_search
```

### Phase 2: Query Rewriter Module

**New File:** `backend/src/search/query-rewriter.ts`

```typescript
import { ChatOpenAI } from '@langchain/openai';
import { debugLogger } from '../utils/debug-logger';

export interface ExpandedQuery {
  original: string;
  normalized: string;
  variants: string[];
  intent: 'price' | 'news' | 'analysis' | 'general';
  timeframe: 'today' | 'week' | 'month' | null;
}

const CRYPTO_SLANG_MAP: Record<string, string> = {
  'crypt': 'cryptocurrency',
  'btc': 'Bitcoin',
  'eth': 'Ethereum',
  'sol': 'Solana',
  'moon': 'price increase',
  'dump': 'price decrease',
  'hodl': 'hold investment',
};

export async function rewriteQuery(
  query: string,
  llm: ChatOpenAI
): Promise<ExpandedQuery> {
  // Fast path: basic regex expansion first
  const basicExpanded = expandBasicSlang(query);

  // LLM expansion for comprehensive variants
  const prompt = `Expand this crypto query with synonyms and related terms:
"${query}"

Provide JSON: {"normalized": "...", "variants": ["...", "..."], "intent": "...", "timeframe": "..."}`;

  try {
    const response = await llm.invoke(prompt);
    const parsed = JSON.parse(cleanJsonResponse(response.content));

    return {
      original: query,
      normalized: parsed.normalized || basicExpanded,
      variants: parsed.variants || [basicExpanded],
      intent: parsed.intent || 'general',
      timeframe: extractTimeframe(query),
    };
  } catch (error) {
    // Fallback to rule-based expansion
    return {
      original: query,
      normalized: basicExpanded,
      variants: [basicExpanded],
      intent: 'general',
      timeframe: extractTimeframe(query),
    };
  }
}

function expandBasicSlang(query: string): string {
  let expanded = query;
  for (const [slang, canonical] of Object.entries(CRYPTO_SLANG_MAP)) {
    const regex = new RegExp(`\\b${slang}\\b`, 'gi');
    expanded = expanded.replace(regex, canonical);
  }
  return expanded;
}

function extractTimeframe(query: string): 'today' | 'week' | 'month' | null {
  if (/\btoday\b|\bnow\b/i.test(query)) return 'today';
  if (/\bweek\b/i.test(query)) return 'week';
  if (/\bmonth\b/i.test(query)) return 'month';
  return null;
}

function cleanJsonResponse(content: any): string {
  const str = typeof content === 'string' ? content : String(content);
  return str.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '').trim();
}
```

### Phase 3: Hybrid Search Module

**New File:** `backend/src/search/hybrid-search.ts`

```typescript
import { prisma } from '../utils/db';
import { OpenRouterEmbeddings } from '../agents/llm';
import { ExpandedQuery } from './query-rewriter';

export interface HybridSearchResult {
  chunkId: string;
  chunkContent: string;
  articleId: string;
  title: string;
  url: string;
  publishedAt: Date;
  vectorScore: number;   // 0-1 from cosine similarity
  lexicalScore: number;  // BM25 rank from ts_rank
  rrfScore: number;      // Reciprocal Rank Fusion score
}

const RRF_K = 60;

export async function hybridSearch(
  expandedQuery: ExpandedQuery,
  embeddings: OpenRouterEmbeddings,
  daysBack: number = 7
): Promise<HybridSearchResult[]> {
  const dateFilter = new Date();
  dateFilter.setDate(dateFilter.getDate() - daysBack);

  // Generate embedding
  const queryEmbedding = await embeddings.embedQuery(expandedQuery.normalized);

  // Execute both searches in parallel
  const [vectorResults, lexicalResults] = await Promise.all([
    vectorSearch(queryEmbedding, dateFilter),
    lexicalSearch(expandedQuery.normalized, dateFilter),
  ]);

  return mergeWithRRF(vectorResults, lexicalResults);
}

async function vectorSearch(embedding: number[], dateFilter: Date) {
  return await prisma.$queryRaw`
    SELECT
      c.id as "chunkId",
      c.content as "chunkContent",
      a.id as "articleId",
      a.title, a.url, a."publishedAt",
      1 - (e.embedding <=> ${JSON.stringify(embedding)}::vector) as similarity
    FROM "ArticleEmbedding" e
    JOIN "ArticleChunk" c ON e."chunkId" = c.id
    JOIN "Article" a ON c."articleId" = a.id
    WHERE a."publishedAt" >= ${dateFilter}
      AND (1 - (e.embedding <=> ${JSON.stringify(embedding)}::vector)) >= 0.35
    ORDER BY similarity DESC
    LIMIT 30
  `;
}

async function lexicalSearch(query: string, dateFilter: Date) {
  // Convert to tsquery format
  const terms = query.split(/\s+/)
    .filter(t => t.length > 2)
    .map(t => t.replace(/[^\w]/g, ''))
    .join(' | ');

  if (!terms) return [];

  return await prisma.$queryRaw`
    SELECT
      c.id as "chunkId",
      c.content as "chunkContent",
      a.id as "articleId",
      a.title, a.url, a."publishedAt",
      ts_rank(c."searchVector", to_tsquery('english', ${terms})) as rank
    FROM "ArticleChunk" c
    JOIN "Article" a ON c."articleId" = a.id
    WHERE a."publishedAt" >= ${dateFilter}
      AND c."searchVector" @@ to_tsquery('english', ${terms})
    ORDER BY rank DESC
    LIMIT 30
  `;
}

function mergeWithRRF(vectorResults: any[], lexicalResults: any[]): HybridSearchResult[] {
  const vectorRankMap = new Map(vectorResults.map((r, i) => [r.chunkId, { rank: i + 1, result: r }]));
  const lexicalRankMap = new Map(lexicalResults.map((r, i) => [r.chunkId, { rank: i + 1, result: r }]));

  const allChunkIds = new Set([
    ...vectorResults.map(r => r.chunkId),
    ...lexicalResults.map(r => r.chunkId),
  ]);

  const merged: HybridSearchResult[] = [];
  for (const chunkId of allChunkIds) {
    const vectorEntry = vectorRankMap.get(chunkId);
    const lexicalEntry = lexicalRankMap.get(chunkId);

    let rrfScore = 0;
    if (vectorEntry) rrfScore += 1 / (RRF_K + vectorEntry.rank);
    if (lexicalEntry) rrfScore += 1 / (RRF_K + lexicalEntry.rank);

    const baseResult = vectorEntry?.result || lexicalEntry?.result;
    merged.push({
      ...baseResult,
      vectorScore: vectorEntry?.result.similarity || 0,
      lexicalScore: lexicalEntry?.result.rank || 0,
      rrfScore,
    });
  }

  return merged.sort((a, b) => b.rrfScore - a.rrfScore);
}
```

### Phase 4: Heuristic Reranker

**New File:** `backend/src/search/reranker.ts`

```typescript
import { HybridSearchResult } from './hybrid-search';

export interface RerankedResult extends HybridSearchResult {
  rerankScore: number;
  relevanceExplanation: string;
}

export function rerankHeuristic(
  query: string,
  candidates: HybridSearchResult[],
  topK: number = 7
): RerankedResult[] {
  const queryTerms = query.toLowerCase().split(/\s+/);

  return candidates.map(c => {
    const titleLower = c.title.toLowerCase();
    const contentLower = c.chunkContent.toLowerCase();

    // Term matching scores
    const titleMatches = queryTerms.filter(t => titleLower.includes(t)).length;
    const titleScore = (titleMatches / queryTerms.length) * 0.3;

    const contentMatches = queryTerms.filter(t => contentLower.includes(t)).length;
    const contentScore = (contentMatches / queryTerms.length) * 0.2;

    // Recency boost (favor articles < 24h old)
    const hoursAgo = (Date.now() - c.publishedAt.getTime()) / (1000 * 60 * 60);
    const recencyBoost = hoursAgo < 24 ? 0.15 : (hoursAgo < 72 ? 0.08 : 0);

    // RRF base score
    const rrfBase = c.rrfScore * 0.35;

    const rerankScore = rrfBase + titleScore + contentScore + recencyBoost;

    return {
      ...c,
      rerankScore,
      relevanceExplanation: `RRF=${c.rrfScore.toFixed(3)}, Title=${titleMatches}/${queryTerms.length}, Recency=${hoursAgo.toFixed(0)}h`,
    };
  })
  .sort((a, b) => b.rerankScore - a.rerankScore)
  .slice(0, topK);
}
```

### Phase 5: Confidence Assessment

**New File:** `backend/src/search/confidence-assessor.ts`

```typescript
import { RerankedResult } from './reranker';

export interface ConfidenceAssessment {
  confidence: 'high' | 'medium' | 'low' | 'none';
  score: number;
  caveat?: string;
}

export function assessConfidence(
  originalQuery: string,
  results: RerankedResult[]
): ConfidenceAssessment {
  if (results.length === 0) {
    return {
      confidence: 'none',
      score: 0,
      caveat: 'No relevant articles found in the database for this query.',
    };
  }

  const topScore = results[0]?.rerankScore || 0;
  const avgScore = results.reduce((sum, r) => sum + r.rerankScore, 0) / results.length;
  const hasStrongMatch = topScore > 0.6;
  const hasMultipleRelevant = results.filter(r => r.rerankScore > 0.4).length >= 2;

  let confidence: 'high' | 'medium' | 'low' | 'none';
  let score: number;
  let caveat: string | undefined;

  if (hasStrongMatch && hasMultipleRelevant) {
    confidence = 'high';
    score = Math.min(topScore * 100, 95);
  } else if (hasStrongMatch || hasMultipleRelevant) {
    confidence = 'medium';
    score = Math.min(avgScore * 100 + 20, 75);
    caveat = 'Results may be partially relevant. Please verify the information.';
  } else {
    confidence = 'low';
    score = Math.min(avgScore * 100, 50);
    caveat = 'Limited relevant information found. Results may not fully answer your query.';
  }

  return { confidence, score, caveat };
}
```

### Phase 6: Integration - Update Search Tool

**File:** `backend/src/tools/searchNews.ts`

Replace the current implementation with the new 4-stage pipeline:

```typescript
import { rewriteQuery } from '../search/query-rewriter';
import { hybridSearch } from '../search/hybrid-search';
import { rerankHeuristic } from '../search/reranker';
import { assessConfidence } from '../search/confidence-assessor';

// In the tool function:
export async function createSearchNewsTool(/* params */) {
  return new DynamicStructuredTool({
    name: 'search_crypto_news',
    description: 'Search cryptocurrency news articles...',
    schema: z.object({
      query: z.string(),
      daysBack: z.number().min(1).max(30).default(7),
      limit: z.number().min(1).max(20).default(7),
    }),
    func: async ({ query, daysBack, limit }) => {
      // Stage 1: Query Rewriting
      const expandedQuery = await rewriteQuery(query, llm);

      // Stage 2: Hybrid Search
      const hybridResults = await hybridSearch(expandedQuery, embeddings, daysBack);

      // Stage 3: Heuristic Reranking
      const reranked = rerankHeuristic(expandedQuery.normalized, hybridResults, limit);

      // Stage 4: Confidence Assessment
      const confidence = assessConfidence(query, reranked);

      // Format results
      const articles = reranked.map((r, idx) => ({
        sourceNumber: idx + 1,
        title: r.title,
        url: r.url,
        publishedAt: r.publishedAt.toISOString(),
        quote: r.chunkContent.substring(0, 300),
        relevance: r.rerankScore,
      }));

      return JSON.stringify({
        articles,
        totalFound: reranked.length,
        confidence: {
          level: confidence.confidence,
          score: confidence.score,
          caveat: confidence.caveat,
        },
      });
    },
  });
}
```

### Phase 7: Update Retrieval Agent

**File:** `backend/src/agents/retrieval.ts`

Update the summary generation to include confidence caveats:

```typescript
// After tool execution, check confidence
const searchResults = JSON.parse(toolResult);

if (searchResults.confidence?.caveat) {
  // Include caveat in the summary generation prompt
  const summaryPrompt = `Answer the question based on these articles.
${searchResults.confidence.caveat}

Include this caveat at the start of your answer.

Question: ${question}
Sources: [...]`;
}
```

## Critical Files Modified

1. `backend/prisma/schema.prisma` - Add searchVector columns
2. `backend/prisma/migrations/[timestamp]_add_fulltext_search/migration.sql` - New migration
3. `backend/src/search/query-rewriter.ts` - New module
4. `backend/src/search/hybrid-search.ts` - New module
5. `backend/src/search/reranker.ts` - New module
6. `backend/src/search/confidence-assessor.ts` - New module
7. `backend/src/tools/searchNews.ts` - Major refactor
8. `backend/src/agents/retrieval.ts` - Minor updates for caveat handling

## Testing Strategy

**Test Query 1: Vocabulary Mismatch**
```
Input: "how is crypt doing today?"
Expected:
- Query rewriter expands to "cryptocurrency crypto Bitcoin Ethereum market"
- Hybrid search finds crypto articles via lexical + vector
- Returns results with high confidence
```

**Test Query 2: Slang Handling**
```
Input: "is BTC mooning?"
Expected:
- Expands to "Bitcoin price increase bullish"
- Returns Bitcoin price articles
```

**Test Query 3: Complex Question**
```
Input: "what is your prediction for crypto in the next month/year based on the last 30 days?"
Expected:
- Expands to "cryptocurrency prediction forecast analysis trends"
- Returns analysis/opinion articles
- daysBack=30 to cover requested timeframe
- Medium/Low confidence with caveat (predictions are speculative)
```

**Test Query 4: No Match**
```
Input: "xyz123 quantum chain"
Expected:
- Returns confidence=none with caveat message
- No results found
```

## Implementation Timeline

1. **Database Migration** (30 min) - Add tsvector, run migration, verify indexes
2. **Query Rewriter** (1 hour) - Create module, test slang expansion
3. **Hybrid Search** (2 hours) - Implement vector + lexical search, test RRF merge
4. **Heuristic Reranker** (45 min) - Create scoring logic
5. **Confidence Assessor** (45 min) - Implement confidence levels and caveats
6. **Integration** (2 hours) - Update searchNews.ts and retrieval.ts
7. **End-to-End Testing** (1.5 hours) - Test all 4 test cases above

**Total: ~8.5 hours**

## Success Criteria

✅ Query "how is crypt doing today?" returns cryptocurrency articles
✅ Query "BTC news" returns Bitcoin articles (not filtered out)
✅ Slang terms are automatically expanded
✅ Low confidence queries return results with helpful caveats
✅ Complex prediction query is handled gracefully with appropriate confidence level
✅ System never returns blank "no results" without helpful context

---

## Additional Consideration: Analytical Queries (Future Enhancement)

### Problem

Complex analytical queries like **"what is your prediction for crypto in the next month/year based on the last 30 days?"** require a different approach than simple retrieval:

- Need to retrieve ALL relevant articles from a time period
- Analyze trends, sentiment, patterns across the corpus
- Synthesize insights from multiple sources
- Generate predictions based on collective data

This is **synthesis/analysis**, not just retrieval. The current 4-stage pipeline retrieves top N relevant documents but doesn't analyze the entire dataset.

### Latest Best Practices (2024-2025 Research)

**1. Agentic RAG**
- Autonomous agents dynamically decide when/what to retrieve
- Self-correct through reflection, adapt strategies
- **Performance gains:** 60-75% cost reduction, 42-96% hallucination reduction
- **Sources:** [IBM Research](https://www.ibm.com/think/topics/agentic-rag), [Medium Guide](https://medium.com/@wendell_89912/building-an-agentic-rag-with-langgraph-a-step-by-step-guide-009c5f0cce0a)

**2. GraphRAG (Microsoft, 2024)**
- Hierarchical graph-based summarization for "global sensemaking"
- Constructs entity-centric graphs with community detection
- Strongly outperforms vector RAG for queries requiring understanding of entire corpus
- **Use case:** Perfect for "analyze all articles from X period"
- **Source:** [ArXiv Paper](https://arxiv.org/abs/2404.16130)

**3. Map-Reduce Pattern**
- **Map:** Extract insights from each document individually
- **Reduce:** Aggregate insights into overall conclusion
- Parallelizable, cost-efficient
- Standard approach for multi-document analysis

### Architecture Options

#### Option 1: Separate Analysis Agent (Recommended for Clean Architecture)

**Structure:**
```
Supervisor
├── Retrieval Agent (existing) - handles factual queries
├── Validation Agent (existing)
└── Analysis Agent (NEW) - handles analytical queries
```

**Analysis Agent Workflow:**
1. Detect analytical intent (keywords: "predict", "trend", "analysis", "based on")
2. Retrieve ALL articles from specified period (not just top 5)
3. Apply map-reduce:
   - **Map:** Extract sentiment, key points, price movements from each article
   - **Reduce:** Aggregate into trends, identify patterns
4. Synthesize prediction/analysis with LLM
5. Return with confidence caveat (predictions are inherently speculative)

**Pros:**
- Clean separation of concerns
- Existing retrieval agent unchanged
- Can optimize analysis separately

**Cons:**
- More complex supervisor routing logic
- Additional agent to maintain

#### Option 2: Enhanced Retrieval Agent

**Approach:** Extend existing retrieval agent to detect analytical queries and switch to map-reduce internally.

**Workflow:**
```typescript
if (queryIsAnalytical(query)) {
  // Retrieve all articles from period
  const allArticles = await searchNews({ daysBack: 30, limit: 50 });

  // Map-reduce analysis
  const insights = await analyzeArticles(allArticles);
  return synthesizePrediction(insights);
} else {
  // Standard retrieval (current approach)
  return standardRetrieval(query);
}
```

**Pros:**
- Simpler architecture (single retrieval agent)
- Faster to implement

**Cons:**
- Mixes retrieval and analysis concerns
- Agent becomes more complex

#### Option 3: GraphRAG Approach (Most Advanced)

**Approach:** Implement Microsoft's GraphRAG for global corpus understanding.

**Steps:**
1. Build knowledge graph from all articles (entities: Bitcoin, Ethereum, regulations, etc.)
2. Detect communities in graph (e.g., "DeFi cluster", "Bitcoin price cluster")
3. Create hierarchical summaries of communities
4. Query against graph for global insights

**Pros:**
- State-of-the-art for corpus-wide analysis
- Handles complex multi-hop reasoning
- Scales to large knowledge bases

**Cons:**
- Significant implementation complexity
- Requires graph database (Neo4j or similar)
- Higher computational cost

### Processing Patterns

#### Pattern A: Map-Reduce (Recommended)

```typescript
// MAP: Analyze each article
const articleInsights = await Promise.all(
  articles.map(article =>
    llm.invoke(`Extract sentiment and key points from: ${article}`)
  )
);

// REDUCE: Aggregate insights
const aggregated = await llm.invoke(`
  Analyze these insights and identify trends:
  ${articleInsights.join('\n')}

  Question: ${originalQuery}
`);
```

**Pros:** Parallelizable, works with large datasets, cost-efficient
**Cons:** May lose some context between documents

#### Pattern B: Single-Pass Analysis

```typescript
// Feed all article summaries at once
const analysis = await llm.invoke(`
  Analyze these ${articles.length} articles and answer:
  ${query}

  Articles:
  ${articles.map(a => a.summary).join('\n\n')}
`);
```

**Pros:** Simpler, preserves context
**Cons:** Token limit issues with many articles (GPT-4: ~128k tokens)

#### Pattern C: Iterative Refinement

```typescript
let analysis = "Initial analysis:";
const batchSize = 10;

for (let i = 0; i < articles.length; i += batchSize) {
  const batch = articles.slice(i, i + batchSize);
  analysis = await llm.invoke(`
    Current analysis: ${analysis}

    New articles to incorporate:
    ${batch}

    Update the analysis with new insights.
  `);
}
```

**Pros:** Handles unlimited articles, refines iteratively
**Cons:** Sequential processing (slower), higher cost

### Query Intent Detection

#### Approach 1: LLM-Based Classification (Most Accurate)

```typescript
const intent = await llm.invoke(`
  Classify this query as either:
  - "retrieval": User wants specific facts/articles
  - "analysis": User wants trends, predictions, synthesis

  Query: "${query}"

  Respond with JSON: {"intent": "...", "reasoning": "..."}
`);
```

**Keywords that suggest analysis:**
- "predict", "prediction", "forecast"
- "trend", "trends", "trending"
- "analysis", "analyze"
- "based on last X days/months"
- "what will happen"
- "sentiment"

#### Approach 2: Keyword-Based Routing (Fast, Rule-Based)

```typescript
const analyticalKeywords = [
  'predict', 'prediction', 'forecast',
  'trend', 'analysis', 'sentiment',
  'based on', 'over the last', 'in the past'
];

const isAnalytical = analyticalKeywords.some(kw =>
  query.toLowerCase().includes(kw)
);
```

**Pros:** Fast, no LLM cost
**Cons:** May miss nuanced analytical queries

#### Approach 3: Hybrid (Recommended)

```typescript
// Fast keyword check first
if (hasAnalyticalKeywords(query)) {
  // Confirm with LLM for accuracy
  const intent = await classifyIntent(query);
  return intent === 'analysis';
}
return false; // Default to retrieval
```

### Implementation Recommendation

**Phase 1 (Current Plan):** Implement 4-stage retrieval pipeline for vocabulary mismatch fix.

**Phase 2 (Future):** Add Analysis Agent with these components:
1. **Intent Detection:** Hybrid keyword + LLM classification
2. **Retrieval Strategy:** Get all articles from specified period (daysBack=30)
3. **Analysis Pattern:** Map-Reduce with parallel processing
4. **Synthesis:** LLM generates prediction with confidence caveat
5. **Integration:** Add "Analysis" node to LangGraph supervisor

**Estimated Additional Effort:** ~12-15 hours
- Intent detection: 2 hours
- Map-reduce implementation: 4 hours
- Analysis agent: 4 hours
- Supervisor integration: 2 hours
- Testing: 3 hours

### Test Case for Analytical Query

**Input:** "what is your prediction for crypto in the next month/year based on the last 30 days?"

**Expected Flow:**
1. Intent detection: "analysis" (keywords: "prediction", "based on last 30 days")
2. Route to Analysis Agent
3. Retrieve ALL articles from last 30 days (daysBack=30, no limit)
4. Map-reduce:
   - Extract sentiment from each article (bullish/bearish)
   - Identify mentioned assets (Bitcoin, Ethereum, etc.)
   - Extract price movements, regulatory news, market events
5. Synthesis:
   - Aggregate sentiment trend (e.g., "60% bullish, 40% bearish")
   - Identify patterns (e.g., "increasing institutional adoption")
   - Generate prediction with strong caveat
6. Response format:
   ```
   Based on analysis of 47 articles from the last 30 days:

   **Sentiment:** Moderately bullish (62% positive coverage)
   **Key Trends:**
   - Bitcoin ETF approval driving institutional interest
   - Ethereum Layer 2 scaling solutions gaining traction
   - Regulatory clarity improving in major markets

   **Prediction (speculative):**
   Short-term (1 month): Continued consolidation with potential 5-10% upside
   Long-term (1 year): Bullish outlook contingent on macro stability

   ⚠️ Disclaimer: This analysis is based on historical news and does not constitute financial advice.
   ```

### Sources

- [IBM: What is Agentic RAG?](https://www.ibm.com/think/topics/agentic-rag)
- [Medium: Building an Agentic RAG with LangGraph](https://medium.com/@wendell_89912/building-an-agentic-rag-with-langgraph-a-step-by-step-guide-009c5f0cce0a)
- [ArXiv: From Local to Global - GraphRAG Approach](https://arxiv.org/abs/2404.16130)
- [Analytics Vidhya: Building Agentic RAG Systems](https://www.analyticsvidhya.com/blog/2024/07/building-agentic-rag-systems-with-langgraph/)
- [GitHub: Awesome RAG Reasoning Resources](https://github.com/DavidZWZ/Awesome-RAG-Reasoning)
