# Crypto News Agent - Implementation Plan

**Project:** AI-powered crypto news agent with real-time answers based on latest news
**Tech Stack:** Node.js + TypeScript + Express + Prisma + PostgreSQL + pgvector + OpenRouter + React + Vite + Tailwind
**Deployment:** Docker Compose on Easypanel
**Testing:** Vitest (backend + frontend)
**Estimated Time:** 27-35 hours

---

## Architecture Overview

### Flow
```
User Question
    ↓
Fetch RSS (3 sources in parallel)
    ↓
Filter NEW articles (check DB)
    ↓
Process NEW articles only:
  - Chunk content (summary + intro + content chunks)
  - Generate embeddings (OpenRouter)
  - Save to PostgreSQL
    ↓
Semantic Search (multi-stage):
  - Vector similarity (pgvector)
  - Re-rank (recency + relevance)
  - Deduplicate (best chunk per article)
    ↓
Build Context (top 5-7 articles with temporal info)
    ↓
Generate Answer (OpenRouter with anti-hallucination prompts)
    ↓
Stream Response (SSE, token-by-token)
    ↓
Display in UI (structured format with clickable citations)
```

### Key Design Decisions

**Database: Prisma + PostgreSQL + pgvector**
- Type safety with auto-generated types
- Migration management built-in
- Raw SQL for vector operations
- Better DX than raw queries

**Embeddings: Hybrid Strategy (OpenRouter)**
- Summary embeddings (broad topic matching)
- Full chunk embeddings (detailed semantics)
- All embeddings via OpenRouter API (not OpenAI)
- Improves query-to-content similarity matching
- Best practice from 2024 RAG research

**Retrieval: Multi-Stage Pipeline**
1. Vector search (top 20 candidates)
2. Re-rank (similarity × recency × diversity)
3. Deduplicate (keep best chunk per article)
4. Select top 5-7 diverse articles

**Anti-Hallucination Measures**
- Explicit "only use provided articles" prompts
- Required citations for every claim [1], [2], [3]
- Confidence scoring (1-100%)
- Temporal awareness (current date/time in prompt)
- Citation validation after generation

**Input Moderation**
- OpenAI Moderation API (free, fast, accurate)
- Checks for hate, harassment, violence, sexual content, self-harm
- Fallback keyword blocklist
- Clear error messages for flagged content

**Concurrent Request Handling**
- Database connection pooling (Prisma, max 20 connections)
- RSS fetch deduplication (queue system)
- Rate limiting (10 requests/minute per IP)
- Timeouts for all external APIs (30s)
- Client disconnect detection during streaming

**Time Range**
- Default: 7 days lookback
- Dynamic: Adjust if query mentions "last month", "two weeks", etc.

---

## Phase 1: Project Setup & Configuration (2-3h)

### 1.1 Initialize Backend
```bash
mkdir backend && cd backend
npm init -y
```

**Install Dependencies:**
```bash
npm install express prisma @prisma/client openai rss-parser express-rate-limit cors dotenv
npm install -D typescript @types/node @types/express @types/cors ts-node nodemon vitest @vitest/ui
```

**Note:** The `openai` package is used for both:
1. OpenRouter integration (LLM + embeddings) - configured with baseURL: 'https://openrouter.ai/api/v1'
2. OpenAI Moderation API (content moderation, free tier)

See: https://openrouter.ai/docs/community/open-ai-sdk.md

**TypeScript Config** (`tsconfig.json`):
- target: ES2020
- module: commonjs
- strict: true
- outDir: ./dist
- rootDir: ./src

**Package Scripts:**
```json
{
  "dev": "nodemon --exec ts-node src/server.ts",
  "build": "tsc && npx prisma generate",
  "start": "node dist/server.js",
  "test": "vitest",
  "prisma:migrate": "npx prisma migrate dev",
  "prisma:generate": "npx prisma generate"
}
```

### 1.2 Initialize Frontend
```bash
cd ../
npm create vite@latest frontend -- --template react-ts
cd frontend
npm install
npm install -D tailwindcss postcss autoprefixer vitest @vitest/ui @testing-library/react @testing-library/jest-dom jsdom
npx tailwindcss init -p
```

**Tailwind Config:** Include `./index.html` and `./src/**/*.{js,ts,jsx,tsx}`

**Vite Config:** Add Vitest configuration

### 1.3 Prisma Setup

**Initialize:**
```bash
cd backend
npx prisma init
```

**Schema** (`prisma/schema.prisma`):
```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

model Article {
  id          String         @id @default(uuid())
  url         String         @unique
  title       String
  content     String         @db.Text
  summary     String?        @db.Text
  source      String
  author      String?
  publishedAt DateTime
  createdAt   DateTime       @default(now())
  chunks      ArticleChunk[]

  @@index([publishedAt])
  @@index([source])
}

model ArticleChunk {
  id         String             @id @default(uuid())
  articleId  String
  article    Article            @relation(fields: [articleId], references: [id], onDelete: Cascade)
  chunkIndex Int
  content    String             @db.Text
  isIntro    Boolean            @default(false)
  isSummary  Boolean            @default(false)
  createdAt  DateTime           @default(now())
  embedding  ArticleEmbedding?

  @@unique([articleId, chunkIndex])
  @@index([articleId])
}

model ArticleEmbedding {
  id        String       @id @default(uuid())
  chunkId   String       @unique
  chunk     ArticleChunk @relation(fields: [chunkId], references: [id], onDelete: Cascade)
  embedding Unsupported("vector(1536)")
  createdAt DateTime     @default(now())

  @@index([embedding], type: Raw("hnsw (embedding vector_cosine_ops)"))
}

model QueryLog {
  id                 String   @id @default(uuid())
  question           String   @db.Text
  articlesRetrieved  Int
  confidence         Int
  processingTimeMs   Int
  createdAt          DateTime @default(now())
}
```

**Enable pgvector** (migration file):
```sql
CREATE EXTENSION IF NOT EXISTS vector;
```

**Run Migration:**
```bash
npx prisma migrate dev --name init
npx prisma generate
```

### 1.4 Docker Configuration

**docker-compose.yml** (root):
```yaml
version: '3.8'

services:
  postgres:
    image: pgvector/pgvector:pg16
    container_name: crypto_news_db
    environment:
      POSTGRES_USER: ${DB_USER:-crypto_agent}
      POSTGRES_PASSWORD: ${DB_PASSWORD}
      POSTGRES_DB: ${DB_NAME:-crypto_news}
    ports:
      - "5432:5432"
    volumes:
      - postgres_data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ${DB_USER:-crypto_agent}"]
      interval: 10s
      timeout: 5s
      retries: 5
    restart: unless-stopped
    networks:
      - crypto_network

  backend:
    build:
      context: ./backend
      dockerfile: Dockerfile
    container_name: crypto_news_backend
    environment:
      DATABASE_URL: postgresql://${DB_USER:-crypto_agent}:${DB_PASSWORD}@postgres:5432/${DB_NAME:-crypto_news}
      OPENROUTER_API_KEY: ${OPENROUTER_API_KEY}
      NODE_ENV: production
      PORT: 3001
    ports:
      - "3001:3001"
    depends_on:
      postgres:
        condition: service_healthy
    restart: unless-stopped
    networks:
      - crypto_network

  frontend:
    build:
      context: ./frontend
      dockerfile: Dockerfile
      args:
        VITE_API_URL: ${VITE_API_URL:-http://localhost:3001}
    container_name: crypto_news_frontend
    ports:
      - "80:80"
    depends_on:
      - backend
    restart: unless-stopped
    networks:
      - crypto_network

networks:
  crypto_network:
    driver: bridge

volumes:
  postgres_data:
```

**Backend Dockerfile** (`backend/Dockerfile`):
```dockerfile
# Stage 1: Build
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
COPY prisma ./prisma/
RUN npm ci
COPY . .
RUN npx prisma generate
RUN npm run build

# Stage 2: Production
FROM node:20-alpine
WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/prisma ./prisma
COPY package*.json ./

HEALTHCHECK --interval=30s --timeout=3s --start-period=40s \
  CMD node -e "require('http').get('http://localhost:3001/health', (r) => process.exit(r.statusCode === 200 ? 0 : 1))"

EXPOSE 3001
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/server.js"]
```

**Frontend Dockerfile** (`frontend/Dockerfile`):
```dockerfile
# Stage 1: Build
FROM node:20-alpine AS builder
WORKDIR /app
ARG VITE_API_URL
ENV VITE_API_URL=$VITE_API_URL
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# Stage 2: Serve
FROM nginx:alpine
COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
HEALTHCHECK --interval=30s CMD wget --quiet --tries=1 --spider http://localhost/ || exit 1
EXPOSE 80
```

**nginx.conf** (`frontend/nginx.conf`):
```nginx
server {
    listen 80;
    root /usr/share/nginx/html;
    index index.html;

    location / {
        try_files $uri $uri/ /index.html;
    }

    location /api {
        proxy_pass http://backend:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}
```

**`.dockerignore`** (backend):
```
node_modules
dist
.env
.env.*
!.env.example
*.log
coverage
.git
```

### 1.5 Environment Files

**`.env.example`** (backend):
```
DATABASE_URL=postgresql://crypto_agent:dev_password@localhost:5432/crypto_news
OPENROUTER_API_KEY=sk-or-v1-...
OPENAI_API_KEY=sk-...
PORT=3001
NODE_ENV=development
FRONTEND_URL=http://localhost:5173
```

**API Key Usage:**
- `OPENROUTER_API_KEY`: LLM (answer generation) + Embeddings
- `OPENAI_API_KEY`: Moderation API only (free tier)

**`.env.example`** (frontend):
```
VITE_API_URL=http://localhost:3001
```

**`.gitignore`** (root - improved):
```
# Dependencies
node_modules/
backend/node_modules/
frontend/node_modules/

# Build outputs
dist/
backend/dist/
frontend/dist/
build/

# Environment
.env
.env.*
!.env.example

# Logs
*.log
logs/

# Testing
coverage/
.nyc_output/

# OS
.DS_Store
Thumbs.db

# IDE
.vscode/
.idea/
*.swp
*.swo

# Prisma
backend/prisma/migrations/*.sql
!backend/prisma/migrations/migration_lock.toml

# Misc
*.tsbuildinfo
```

### 1.6 Documentation to Fetch Before Implementation

**Required API Documentation:**
1. **OpenRouter API:** https://openrouter.ai/docs (LLM + embeddings)
2. **OpenAI Moderation API:** https://platform.openai.com/docs/guides/moderation (content moderation)
3. **Prisma Docs:** https://www.prisma.io/docs (client usage, migrations)
4. **RSS Parser:** https://www.npmjs.com/package/rss-parser (API reference)
5. **pgvector:** https://github.com/pgvector/pgvector (vector operations, indexing)

**Fetch these before implementing respective modules!**

---

## Phase 2: RSS Ingestion System (4-5h)

### 2.1 RSS Source Configuration

**File:** `backend/src/ingestion/sources.ts`

**Three verified sources:**

| Source | URL | Key Fields | Content Field |
|--------|-----|------------|---------------|
| DL News | `https://www.dlnews.com/arc/outboundfeeds/rss/` | title, link, dc:creator, pubDate, content:encoded | content:encoded (full HTML) |
| Cointelegraph | `https://cointelegraph.com/rss` | title, link, dc:creator, pubDate, description | description (HTML with image) |
| The Defiant | `https://thedefiant.io/api/feed` | title, link, dc:creator, pubDate, content:encoded, description | content:encoded (priority), description (fallback) |

**Implementation:**
- Define `RSSSource` interface: { name, url, contentField }
- Export array of sources
- Each source has specific parsing strategy

### 2.2 RSS Fetcher

**File:** `backend/src/ingestion/rss-fetcher.ts`

**Features:**
- Fetch all 3 sources in parallel using `Promise.allSettled`
- Retry logic: 3 attempts with exponential backoff (1s, 2s, 4s)
- HTML stripping: Remove all tags, decode entities, normalize whitespace
- Date parsing: Convert RFC 822 to Date object
- Error handling: Log failures but continue with successful feeds
- Return standardized `RawArticle[]` interface

**RawArticle Interface:**
```typescript
interface RawArticle {
  url: string;
  title: string;
  content: string;
  publishedAt: Date;
  source: string;
  author: string | null;
}
```

**HTML Stripping Function:**
- Remove all `<tags>`
- Decode HTML entities (&amp;, &lt;, &quot;, etc.)
- Replace multiple whitespace with single space
- Trim result

### 2.3 Article Filter

**File:** `backend/src/ingestion/filter.ts`

**Function:** `filterNewArticles(articles: RawArticle[]): Promise<RawArticle[]>`

**Logic:**
1. Extract all URLs from fetched articles
2. Query Prisma: `prisma.article.findMany({ where: { url: { in: urls } }, select: { url: true } })`
3. Create Set of existing URLs
4. Filter articles to keep only NEW ones (not in Set)
5. Log stats: `{fetched: N, existing: M, new: K}`
6. Return new articles only

### 2.4 Hybrid Chunking Strategy

**File:** `backend/src/ingestion/chunker.ts`

**For each article, create multiple chunks:**

**1. Summary Chunk** (`isIntro: true, isSummary: true`):
- Generate 2-3 sentence summary via OpenRouter
- Purpose: Broad topic matching
- Embed this summary

**2. Intro Chunk** (`isIntro: true, isSummary: false`):
- Title + first 600 words
- Purpose: Semantic search for article start
- Embed full content

**3. Content Chunks** (`isIntro: false`):
- Split remaining content into 600-word chunks
- 100-word overlap between chunks
- Skip chunks < 50 words
- Embed each chunk

**Why Hybrid?**
- Summary embeddings help match broad queries ("What's happening with Bitcoin?")
- Full chunks capture detailed semantics ("Explain the SEC's new ETF ruling")
- Improves similarity scoring (query length vs content length matching)

**Function:** `chunkArticle(article: RawArticle): Promise<ArticleChunk[]>`

### 2.5 Embedding Generation

**Implementation:** Part of `OpenRouterAgent` class (using OpenAI SDK with OpenRouter base URL)

**Configuration:**
- Model: `qwen/qwen3-embedding-0.6b` (as specified by user)
- Batch size: 100 texts per request
- Input limit: 8000 characters per text (truncate if needed)
- Uses OpenAI SDK configured with `baseURL: 'https://openrouter.ai/api/v1'`

**Method:** `agent.generateEmbeddings(texts: string[]): Promise<number[][]>`

**Logic:**
1. Split texts into batches of 100
2. Truncate each text to 8000 characters if needed
3. Call `client.embeddings.create()` for each batch
4. Collect all embeddings (dimension based on model)
5. Return as array of vectors

**Error Handling:**
- OpenAI SDK handles retries automatically
- Log errors but throw to fail the batch (transaction will rollback)
- Ensures data consistency

### 2.6 Article Processor

**File:** `backend/src/ingestion/processor.ts`

**Main Function:** `processNewArticles(articles: RawArticle[]): Promise<void>`

**For each new article:**
1. Generate summary chunk (via OpenRouter LLM)
2. Create intro chunk + content chunks
3. Generate embeddings for all chunks (batch)
4. Save to database via Prisma transaction

**Transaction Structure:**
```typescript
await prisma.$transaction(async (tx) => {
  // 1. Create article
  const article = await tx.article.create({...});

  // 2. Create chunks
  const chunks = await Promise.all(
    chunkData.map(c => tx.articleChunk.create({...}))
  );

  // 3. Create embeddings
  await Promise.all(
    chunks.map((chunk, i) => tx.articleEmbedding.create({
      chunkId: chunk.id,
      embedding: embeddings[i] // Use Prisma.sql for vector type
    }))
  );
});
```

**Error Handling:**
- Rollback transaction on any failure
- Log failed articles
- Continue with remaining articles

### 2.7 Concurrent Request Handling & Ingestion Queue

**File:** `backend/src/ingestion/queue.ts`

**Purpose:** Prevent duplicate RSS fetches when multiple requests arrive simultaneously

**Implementation:**
```typescript
class IngestionQueue {
  private isIngesting = false;
  private lastResult: IngestionStats | null = null;
  private lastIngestTime = 0;
  private waitingRequests: Array<(result: IngestionStats) => void> = [];

  async ingest(): Promise<IngestionStats> {
    // If ingestion happened in last 10 seconds, return cached result
    if (Date.now() - this.lastIngestTime < 10000 && this.lastResult) {
      return this.lastResult;
    }

    // If currently ingesting, wait for it to finish
    if (this.isIngesting) {
      return new Promise(resolve => {
        this.waitingRequests.push(resolve);
      });
    }

    this.isIngesting = true;

    try {
      const result = await fetchAndProcessNews();
      this.lastResult = result;
      this.lastIngestTime = Date.now();

      // Resolve all waiting requests
      this.waitingRequests.forEach(resolve => resolve(result));
      this.waitingRequests = [];

      return result;
    } finally {
      this.isIngesting = false;
    }
  }
}

export const ingestionQueue = new IngestionQueue();
```

### 2.8 Main Ingestion Flow

**File:** `backend/src/ingestion/index.ts`

**Function:** `ingestLatestNews(): Promise<IngestionStats>`

**Flow:**
1. Fetch all RSS feeds (parallel, with 30s timeout per source)
2. Filter for new articles (database check)
3. Process new articles (chunk + embed + save)
4. Return stats: `{fetched, new, processed, errors}`

**Edge Cases Handled:**
- All RSS sources fail → Throw clear error
- Some sources fail → Continue with successful ones
- No new articles → Return quickly with stats
- API timeout → Retry with exponential backoff (max 3 attempts)
- Database connection failure → Throw error with retry suggestion

**Called:** Via `ingestionQueue.ingest()` on every user query (ensures fresh data, prevents duplicates)

---

## Phase 3: Semantic Search & Retrieval (3-4h)

### 3.1 Multi-Stage Retrieval Pipeline

**File:** `backend/src/search/retriever.ts`

**Function:** `retrieveRelevantArticles(query: string, daysBack: number = 7): Promise<SearchResult[]>`

#### Stage 1: Initial Vector Search

**Steps:**
1. Generate query embedding via OpenRouter
2. Calculate date cutoff: `NOW() - INTERVAL '{daysBack} days'`
3. Execute pgvector search using Prisma raw SQL:

```sql
SELECT
  c.id as chunk_id,
  c.content as chunk_content,
  c.chunk_index,
  c.is_intro,
  c.is_summary,
  1 - (e.embedding <=> $queryVector) as similarity,
  a.id as article_id,
  a.title,
  a.summary,
  a.source,
  a.url,
  a.published_at
FROM article_embeddings e
JOIN article_chunks c ON e.chunk_id = c.id
JOIN articles a ON c.article_id = a.id
WHERE
  a.published_at >= $dateFilter
  AND (1 - (e.embedding <=> $queryVector)) >= 0.75
ORDER BY similarity DESC
LIMIT 20
```

**Parameters:**
- `$queryVector`: Generated embedding as `[0.1, 0.2, ...]` (1536 dimensions)
- `$dateFilter`: 7 days ago (or dynamic based on query)
- Similarity threshold: 0.75 (75% cosine similarity)
- Limit: 20 candidates

#### Stage 2: Re-Ranking

**File:** `backend/src/search/reranker.ts`

**Function:** `rerankResults(results: RawSearchResult[]): SearchResult[]`

**Scoring Algorithm:**
```typescript
function calculateScore(result: RawSearchResult): number {
  const similarity = result.similarity; // 0-1

  // Boost factors
  const introBoost = result.isIntro ? 1.2 : 1.0;
  const summaryBoost = result.isSummary ? 1.5 : 1.0;

  // Recency weight (exponential decay)
  const daysAgo = (Date.now() - result.publishedAt.getTime()) / (1000 * 60 * 60 * 24);
  const recencyWeight = Math.exp(-daysAgo * 0.15);

  // Combined score
  return similarity * introBoost * summaryBoost * recencyWeight;
}
```

**Sort by score descending**

#### Stage 3: Deduplication

**Purpose:** Ensure diversity (no redundant articles)

**Logic:**
1. Group results by `article_id`
2. For each article, keep chunk with highest score
3. This ensures max 1 chunk per article in final results

#### Stage 4: Final Selection

**Steps:**
1. Sort deduplicated results by score DESC
2. Select top 5-7 articles
3. Return as `SearchResult[]`

**SearchResult Interface:**
```typescript
interface SearchResult {
  article: {
    id: string;
    title: string;
    summary: string;
    source: string;
    url: string;
    publishedAt: Date;
  };
  chunk: {
    content: string;
    chunkIndex: number;
    isIntro: boolean;
    isSummary: boolean;
  };
  relevance: number; // 0-100 (similarity * 100)
  recencyHours: number; // Hours since publication
}
```

### 3.2 Lost-in-the-Middle Mitigation

**File:** `backend/src/search/context-builder.ts`

**Technique:** Place most important articles at START and END of context

**Algorithm:**
```typescript
function reorderForAttention(results: SearchResult[]): SearchResult[] {
  if (results.length <= 2) return results;

  const [first, ...rest] = results;
  const last = rest.pop()!;

  return [first, ...rest, last]; // Best first, second-best last, rest in middle
}
```

**Research Basis:** LLMs pay more attention to start/end of context window

### 3.3 Context Builder

**Function:** `buildContext(results: SearchResult[]): string`

**Format for each article:**
```
[{number}] {title}
Source: {source} | Published: {ISO timestamp} ({X hours ago})
Relevance: {similarity}% | Author: {author}

Summary: {AI-generated summary}

Relevant Content:
{chunk content (max 800 characters)}

Full article: {url}

---
```

**Output:** Concatenated string of all formatted articles

---

## Phase 4: LLM Agent with Anti-Hallucination (3-4h)

### 4.1 OpenRouter Agent

**File:** `backend/src/agents/openrouter-agent.ts`

**Implementation:** Uses the official OpenAI SDK configured for OpenRouter
- Base URL: `https://openrouter.ai/api/v1`
- Embedding Model: `qwen/qwen3-embedding-0.6b`
- LLM Model: `google/gemini-2.5-flash`
- Temperature: 0.2 (factual, less creative)
- Max tokens: 2000
- Streaming: Enabled

**Class Structure:**
```typescript
class OpenRouterAgent {
  private client: OpenAI;  // OpenAI SDK configured for OpenRouter

  constructor(apiKey: string);

  async generateEmbeddings(texts: string[]): Promise<number[][]>;

  async generateSummary(article: RawArticle): Promise<string>;

  async *streamAnswer(systemPrompt: string, userPrompt: string): AsyncGenerator<string>;
}
```

### 4.2 System Prompt (Anti-Hallucination)

**File:** `backend/src/prompts/system-prompt.ts`

**Template:**
```
You are a crypto news analyst with access to the latest news articles.

CURRENT DATE AND TIME: {currentDateTime in ISO 8601}

Your task is to answer questions based ONLY on the provided news articles.

CRITICAL RULES:
1. Use ONLY information explicitly stated in the provided articles
2. EVERY factual claim must have a citation: [1], [2], [3]
3. Pay attention to article publication times - prioritize recent information
4. If the articles don't contain the answer, clearly state: "I don't have recent information on this topic"
5. NEVER add information from your training data or general knowledge
6. Multiple articles may have conflicting info - cite both and note the discrepancy

RESPONSE FORMAT (follow exactly):

## TL;DR
[Single sentence summary of your answer]

## Details
[Comprehensive answer with all key facts. Include citation [1], [2] after EVERY claim. Be thorough but concise.]

## Context
[Relevant background information that helps understand the topic. Include citations for all facts.]

## Confidence
[Your confidence in this answer as a percentage from 1-100%. Consider: source quality, information completeness, recency, and whether sources agree. Just state the number, e.g., "85" or "85%"]

Remember: Only use information from the provided articles. Every factual claim needs a citation [1], [2], etc. If unsure, say you don't know.
```

**Variables:**
- `{currentDateTime}`: `new Date().toISOString()`

### 4.3 User Prompt Builder

**File:** `backend/src/prompts/user-prompt.ts`

**Template:**
```
{contextFromArticles}

---

QUESTION: {userQuestion}

Remember to cite sources [1], [2], [3] for every claim. Follow the response format exactly.
```

### 4.4 Response Parser

**File:** `backend/src/utils/response-parser.ts`

**Function:** `parseStructuredResponse(rawResponse: string): ParsedResponse`

**Logic:**
1. Extract TL;DR section: Regex `## TL;DR\n(.*?)(?=##|$)`
2. Extract Details section: Regex `## Details\n(.*?)(?=##|$)`
3. Extract Context section: Regex `## Context\n(.*?)(?=##|$)`
4. Extract Confidence: Regex in Confidence section `(\d+)%?`, parse int, clamp 1-100
5. Extract citations from Details + Context: Regex `\[(\d+)\]`, collect unique numbers

**ParsedResponse Interface:**
```typescript
interface ParsedResponse {
  tldr: string;
  details: {
    content: string;
    citations: number[]; // e.g., [1, 2, 3]
  };
  context: {
    content: string;
    citations: number[];
  };
  confidence: number; // 1-100
}
```

### 4.5 Citation Validator

**Function:** `validateCitations(parsed: ParsedResponse, sourceCount: number): ValidationResult`

**Checks:**
1. All citations are valid numbers (≥ 1, ≤ sourceCount)
2. Details section has citations (if content > 100 chars)
3. No broken citation references

**Return:**
```typescript
interface ValidationResult {
  valid: boolean;
  issues: string[]; // e.g., ["Invalid citation [8] - only 5 sources available"]
}
```

**Log warnings** if validation fails (but don't block response)

---

## Phase 5: API Endpoints (3-4h)

### 5.1 POST /ask (Main Endpoint)

**File:** `backend/src/api/ask.ts`

**Request:**
```typescript
interface AskRequest {
  question: string;
}
```

**Validation:**
- `question` is required string
- Length: 1-500 characters
- Rate limit: 10 requests/minute per IP
- Content moderation check

**Response:** Server-Sent Events (SSE)

**Flow:**

#### 1. Validate Input
```typescript
if (!question || typeof question !== 'string') {
  return res.status(400).json({ error: 'Question is required' });
}
if (question.length > 500) {
  return res.status(400).json({ error: 'Question too long (max 500 chars)' });
}
```

#### 2. Content Moderation (NEW)
```typescript
const moderation = await moderateInput(question);
if (moderation.flagged) {
  return res.status(400).json({
    error: 'Your question contains inappropriate content',
    details: 'Please rephrase your question respectfully.',
    categories: moderation.categories
  });
}
```

**Moderation Implementation:** See Phase 5.5 below

#### 3. Setup SSE
```typescript
res.setHeader('Content-Type', 'text/event-stream');
res.setHeader('Cache-Control', 'no-cache');
res.setHeader('Connection', 'keep-alive');
res.setHeader('X-Accel-Buffering', 'no');

// Handle client disconnect
req.on('close', () => {
  console.log('Client disconnected');
  streamAborted = true;
});
```

#### 4. Ingest Latest News
```typescript
const startTime = Date.now();

// Use queue to prevent duplicate fetches
const ingestStats = await ingestionQueue.ingest();

// Send metadata event
res.write(`event: metadata\n`);
res.write(`data: ${JSON.stringify({
  queryTimestamp: new Date().toISOString(),
  articlesAnalyzed: await getTotalArticleCount(),
  newArticlesProcessed: ingestStats.processed
})}\n\n`);
```

#### 5. Semantic Search
```typescript
const daysBack = extractTimeRange(question); // Default 7, or parse from query
const searchResults = await retrieveRelevantArticles(question, daysBack);

if (searchResults.length === 0) {
  // Send "no results" response
  res.write(`event: structured\n`);
  res.write(`data: ${JSON.stringify({
    tldr: "No relevant recent crypto news found on this topic.",
    details: {
      content: "I don't have recent information about this in my news database. Try rephrasing your question or asking about a different crypto topic.",
      citations: []
    },
    context: {
      content: "This could mean the topic is very new, niche, or not covered by the sources I monitor (DL News, The Defiant, Cointelegraph).",
      citations: []
    },
    confidence: 10
  })}\n\n`);
  res.write(`event: done\n`);
  res.write(`data: ${JSON.stringify({ processingTime: Date.now() - startTime })}\n\n`);
  res.end();
  return;
}
```

#### 6. Send Sources
```typescript
const sources = searchResults.map((r, i) => ({
  number: i + 1,
  title: r.article.title,
  source: r.article.source,
  url: r.article.url,
  publishedAt: r.article.publishedAt.toISOString(),
  relevance: r.relevance
}));

res.write(`event: sources\n`);
res.write(`data: ${JSON.stringify(sources)}\n\n`);
```

#### 7. Build Context & Generate Answer
```typescript
const context = buildContext(searchResults);
const systemPrompt = buildSystemPrompt(new Date());
const userPrompt = buildUserPrompt(context, question);

res.write(`event: status\n`);
res.write(`data: ${JSON.stringify({ message: "Generating answer..." })}\n\n`);

let fullResponse = '';
let streamAborted = false;

try {
  for await (const token of agent.streamAnswer(systemPrompt + '\n\n' + userPrompt)) {
    if (streamAborted) break; // Stop if client disconnected

    fullResponse += token;
    res.write(`event: token\n`);
    res.write(`data: ${JSON.stringify({ token })}\n\n`);
  }
} catch (error) {
  if (error.name === 'AbortError') {
    console.log('Stream aborted by timeout or disconnect');
    return;
  }
  throw error;
}
```

#### 8. Parse & Validate Response
```typescript
const parsed = parseStructuredResponse(fullResponse);
const validation = validateCitations(parsed, searchResults.length);

if (!validation.valid) {
  console.warn('Citation issues:', validation.issues);
}
```

#### 9. Send Structured Data
```typescript
res.write(`event: structured\n`);
res.write(`data: ${JSON.stringify({
  tldr: parsed.tldr,
  details: parsed.details,
  context: parsed.context,
  confidence: parsed.confidence
})}\n\n`);
```

#### 10. Send Done & Log
```typescript
const processingTime = Date.now() - startTime;

res.write(`event: done\n`);
res.write(`data: ${JSON.stringify({ processingTime })}\n\n`);
res.end();

// Log query (fire and forget - don't await)
prisma.queryLog.create({
  data: {
    question,
    articlesRetrieved: searchResults.length,
    confidence: parsed.confidence,
    processingTimeMs: processingTime
  }
}).catch(err => console.error('Failed to log query:', err));
```

**Error Handling:**
```typescript
try {
  // ... flow above
} catch (error) {
  console.error('Error in /ask:', error);

  if (!res.headersSent) {
    res.status(500).json({ error: 'Internal server error' });
  } else {
    res.write(`event: error\n`);
    res.write(`data: ${JSON.stringify({ error: 'Processing failed' })}\n\n`);
    res.end();
  }
}
```

### 5.2 GET /health

**File:** `backend/src/api/health.ts`

**Purpose:** Health check for Docker, monitoring

**Response:**
```typescript
interface HealthResponse {
  status: 'healthy' | 'unhealthy';
  database: 'connected' | 'disconnected';
  totalArticles: number;
  latestArticle: string | null; // ISO timestamp
  timestamp: string; // Current time
}
```

**Implementation:**
```typescript
export async function healthCheck(req, res) {
  try {
    // Check database
    await prisma.$queryRaw`SELECT 1`;

    // Get stats
    const totalArticles = await prisma.article.count();
    const latest = await prisma.article.findFirst({
      orderBy: { publishedAt: 'desc' },
      select: { publishedAt: true }
    });

    res.json({
      status: 'healthy',
      database: 'connected',
      totalArticles,
      latestArticle: latest?.publishedAt?.toISOString() || null,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(503).json({
      status: 'unhealthy',
      database: 'disconnected',
      timestamp: new Date().toISOString()
    });
  }
}
```

### 5.3 Middleware

**File:** `backend/src/api/middleware.ts`

#### CORS Middleware
```typescript
import cors from 'cors';

export const corsMiddleware = cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:5173',
  credentials: true
});
```

#### Rate Limiting
```typescript
import rateLimit from 'express-rate-limit';

export const rateLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 10, // 10 requests per minute
  message: { error: 'Too many requests, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false
});
```

#### Error Handler
```typescript
export function errorHandler(err, req, res, next) {
  console.error('Error:', err);

  res.status(err.status || 500).json({
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
}
```

#### Request Logger
```typescript
export function requestLogger(req, res, next) {
  const start = Date.now();

  res.on('finish', () => {
    const duration = Date.now() - start;
    console.log(`${req.method} ${req.path} - ${res.statusCode} - ${duration}ms`);
  });

  next();
}
```

### 5.4 Server Setup

**File:** `backend/src/server.ts`

```typescript
import express from 'express';
import dotenv from 'dotenv';
import { PrismaClient } from '@prisma/client';
import { corsMiddleware, rateLimiter, errorHandler, requestLogger } from './api/middleware';
import { handleAsk } from './api/ask';
import { healthCheck } from './api/health';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

// Global middleware
app.use(express.json());
app.use(corsMiddleware);
app.use(requestLogger);

// Routes
app.get('/health', healthCheck);
app.post('/ask', rateLimiter, handleAsk);

// Error handler
app.use(errorHandler);

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📊 Health check: http://localhost:${PORT}/health`);
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('Shutting down gracefully...');
  await prisma.$disconnect();
  process.exit(0);
});
```

### 5.5 Content Moderation

**File:** `backend/src/utils/moderation.ts`

**Purpose:** Prevent offensive/harmful input using OpenAI Moderation API

**API Choice:**
- **OpenAI Moderation API** (free tier, no cost)
- Fast (2-5ms latency)
- Accurate detection of: hate, harassment, violence, sexual content, self-harm
- Uses existing `OPENAI_API_KEY` from .env

**Implementation:**

```typescript
import OpenAI from 'openai';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

interface ModerationResult {
  flagged: boolean;
  categories: string[];
  reason?: string;
}

export async function moderateInput(text: string): Promise<ModerationResult> {
  try {
    const response = await openai.moderations.create({
      input: text,
      model: 'text-moderation-latest'
    });

    const result = response.results[0];

    if (result.flagged) {
      const flaggedCategories = Object.entries(result.categories)
        .filter(([_, flagged]) => flagged)
        .map(([category]) => category);

      return {
        flagged: true,
        categories: flaggedCategories,
        reason: `Content flagged for: ${flaggedCategories.join(', ')}`
      };
    }

    return { flagged: false, categories: [] };

  } catch (error) {
    console.error('Moderation API error:', error);
    // Fallback to keyword filter if API fails
    return fallbackModeration(text);
  }
}

// Fallback: Simple keyword blocklist
function fallbackModeration(text: string): ModerationResult {
  const keywords = [
    // Add common offensive terms (censored for documentation)
    // This is a backup if OpenAI API is unavailable
  ];

  const lowerText = text.toLowerCase();
  const found = keywords.find(kw => lowerText.includes(kw));

  if (found) {
    return {
      flagged: true,
      categories: ['offensive_language'],
      reason: 'Potentially offensive content detected'
    };
  }

  return { flagged: false, categories: [] };
}
```

**Usage in /ask endpoint:** Already added in section 5.1 step 2

**Frontend Error Handling:**

```typescript
// In frontend/src/hooks/useStreamingAnswer.ts
if (response.status === 400) {
  const error = await response.json();
  if (error.categories) {
    setState(prev => ({
      ...prev,
      error: 'Please rephrase your question respectfully.'
    }));
  }
}
```

**User Experience:**
- Clear, non-judgmental error message
- No details about specific violations (privacy)
- Encourages rephrasing

---

## Phase 6: Frontend (4-5h)

### 6.1 Type Definitions

**File:** `frontend/src/types/index.ts`

```typescript
export interface StructuredAnswer {
  tldr: string;
  details: {
    content: string;
    citations: number[];
  };
  context: {
    content: string;
    citations: number[];
  };
  confidence: number;
  metadata?: {
    queryTimestamp: string;
    newsTimestamp?: string;
    articlesAnalyzed: number;
    processingTime?: number;
  };
  sources: ArticleSource[];
}

export interface ArticleSource {
  number: number;
  title: string;
  source: string;
  url: string;
  publishedAt: string;
  relevance: number;
}

export type SSEEventType = 'metadata' | 'sources' | 'status' | 'token' | 'structured' | 'done' | 'error';

export interface SSEEvent {
  type: SSEEventType;
  data: any;
}
```

### 6.2 Streaming Hook

**File:** `frontend/src/hooks/useStreamingAnswer.ts`

**State:**
```typescript
interface StreamingState {
  isStreaming: boolean;
  status: string;
  tokens: string[];
  sources: ArticleSource[];
  answer: StructuredAnswer | null;
  error: string | null;
}
```

**Implementation:**
```typescript
export function useStreamingAnswer() {
  const [state, setState] = useState<StreamingState>({
    isStreaming: false,
    status: '',
    tokens: [],
    sources: [],
    answer: null,
    error: null
  });

  const askQuestion = useCallback(async (question: string) => {
    // Reset state
    setState({
      isStreaming: true,
      status: 'Preparing...',
      tokens: [],
      sources: [],
      answer: null,
      error: null
    });

    try {
      const response = await fetch(`${import.meta.env.VITE_API_URL}/ask`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question })
      });

      if (!response.ok) {
        throw new Error(await response.text());
      }

      const reader = response.body?.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.trim()) continue;

          const [eventLine, dataLine] = line.split('\n');
          if (!eventLine?.startsWith('event:') || !dataLine?.startsWith('data:')) continue;

          const eventType = eventLine.substring(6).trim();
          const eventData = JSON.parse(dataLine.substring(5).trim());

          handleSSEEvent({ type: eventType as SSEEventType, data: eventData });
        }
      }
    } catch (error) {
      setState(prev => ({
        ...prev,
        isStreaming: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      }));
    }
  }, []);

  const handleSSEEvent = (event: SSEEvent) => {
    switch (event.type) {
      case 'metadata':
        setState(prev => ({ ...prev, status: 'Analyzing articles...' }));
        break;

      case 'sources':
        setState(prev => ({ ...prev, sources: event.data }));
        break;

      case 'status':
        setState(prev => ({ ...prev, status: event.data.message }));
        break;

      case 'token':
        setState(prev => ({ ...prev, tokens: [...prev.tokens, event.data.token] }));
        break;

      case 'structured':
        setState(prev => ({
          ...prev,
          answer: { ...event.data, sources: prev.sources }
        }));
        break;

      case 'done':
        setState(prev => ({ ...prev, isStreaming: false, status: 'Complete' }));
        break;

      case 'error':
        setState(prev => ({
          ...prev,
          isStreaming: false,
          error: event.data.error
        }));
        break;
    }
  };

  return { ...state, askQuestion };
}
```

### 6.3 Components

#### QuestionInput.tsx

**Props:** `{ onSubmit: (q: string) => void, disabled: boolean }`

**Features:**
- Textarea with auto-resize
- Character counter (0/500)
- Submit button (disabled while streaming)
- Enter to submit, Shift+Enter for newline
- Validation: non-empty, ≤500 chars

#### LoadingIndicator.tsx

**Props:** `{ status: string }`

**UI:**
- Animated spinner (CSS rotate animation)
- Robot emoji in center
- Status text below
- Tailwind: `animate-spin`, `rounded-full`, `border-4`

#### ConfidenceBadge.tsx

**Props:** `{ score: number }`

**Logic:**
```typescript
const getConfig = (score: number) => {
  if (score >= 80) return { label: 'High', color: 'green', icon: '✓' };
  if (score >= 60) return { label: 'Good', color: 'blue', icon: '○' };
  if (score >= 40) return { label: 'Medium', color: 'yellow', icon: '◐' };
  return { label: 'Low', color: 'orange', icon: '!' };
};
```

**UI:**
- Color-coded badge
- Progress bar visualization
- Label + percentage

#### SourceCard.tsx

**Props:** `ArticleSource & { id: string }`

**UI:**
- Number badge (blue circle with white text)
- Title (bold)
- Source name + relevance badge
- Time ago ("3 hours ago")
- "Read full article →" link (opens in new tab)
- Hover effect (border color change)

#### StructuredAnswer.tsx

**Props:** `{ answer: StructuredAnswer, streamingTokens?: string[] }`

**Features:**

**Metadata Bar:**
- Query timestamp
- Latest news timestamp
- Articles analyzed count

**Confidence Badge:** (from ConfidenceBadge component)

**TL;DR Section:**
- Blue highlighted box
- Lightning emoji icon
- Large, bold text

**Details Section:**
- White card with border
- Chart emoji icon
- Content with clickable citations
- Streaming cursor if `streamingTokens` provided

**Context Section:**
- Collapsible white card
- Book emoji icon
- Content with clickable citations

**Sources Section:**
- Grid of SourceCard components
- Each card has unique `id="source-{number}"`

**Citation Click Handler:**
```typescript
const handleCitationClick = (num: number) => {
  const element = document.getElementById(`source-${num}`);
  element?.scrollIntoView({ behavior: 'smooth', block: 'center' });

  // Highlight effect
  element?.classList.add('ring-4', 'ring-blue-400');
  setTimeout(() => {
    element?.classList.remove('ring-4', 'ring-blue-400');
  }, 2000);
};
```

**Citation Rendering:**
```typescript
const renderWithCitations = (content: string) => {
  const parts = content.split(/(\[\d+\])/g);
  return parts.map((part, i) => {
    const match = part.match(/\[(\d+)\]/);
    if (match) {
      return (
        <button key={i} onClick={() => handleCitationClick(+match[1])}>
          {part}
        </button>
      );
    }
    return <span key={i}>{part}</span>;
  });
};
```

### 6.4 Main App

**File:** `frontend/src/App.tsx`

**Structure:**
```tsx
function App() {
  const { isStreaming, status, tokens, answer, error, askQuestion } = useStreamingAnswer();

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100">
      <div className="container mx-auto px-4 py-8">
        {/* Header */}
        <header className="text-center mb-12">
          <h1 className="text-5xl font-bold text-gray-900 mb-2">
            Crypto News Agent
          </h1>
          <p className="text-xl text-gray-600">
            AI-powered answers from the latest crypto news
          </p>
        </header>

        {/* Question Input */}
        <QuestionInput onSubmit={askQuestion} disabled={isStreaming} />

        {/* Error Display */}
        {error && (
          <div className="error-box">
            ⚠️ Error: {error}
          </div>
        )}

        {/* Loading State */}
        {isStreaming && !answer && (
          <LoadingIndicator status={status} />
        )}

        {/* Streaming Answer */}
        {isStreaming && answer && (
          <StructuredAnswer answer={answer} streamingTokens={tokens} />
        )}

        {/* Complete Answer */}
        {!isStreaming && answer && (
          <StructuredAnswer answer={answer} />
        )}

        {/* Footer */}
        <footer className="text-center mt-16 text-gray-600 text-sm">
          Powered by OpenRouter • Sources: DL News, The Defiant, Cointelegraph
        </footer>
      </div>
    </div>
  );
}
```

---

## Phase 7: Automated Testing (4-5h)

### 7.1 Backend Tests (Vitest)

**Config:** `backend/vitest.config.ts`

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/types/**']
    }
  }
});
```

#### Unit Tests

**`tests/unit/rss-fetcher.test.ts`:**
- Test HTML stripping (tags, entities, whitespace)
- Test date parsing (RFC 822 → Date)
- Test field extraction from each source
- Mock fetch calls

**`tests/unit/embedder.test.ts`:**
- Test batch splitting (100 per batch)
- Test OpenRouter API calls (mocked)
- Test error handling (rate limits, failures)
- Test empty input

**`tests/unit/response-parser.test.ts`:**
- Test section extraction (TL;DR, Details, Context)
- Test citation parsing (`[1]`, `[2, 3]`)
- Test confidence extraction (with/without %)
- Test edge cases (missing sections)

**`tests/unit/reranker.test.ts`:**
- Test scoring algorithm (similarity × boosts × recency)
- Test deduplication (keep best chunk per article)
- Test sorting (score descending)

#### Integration Tests

**`tests/integration/processor.test.ts`:**
- Setup test database with pgvector
- Test full article processing (chunk + embed + save)
- Verify database entries (article, chunks, embeddings)
- Test transaction rollback on error

**`tests/integration/retriever.test.ts`:**
- Seed test DB with sample articles + embeddings
- Test vector search with query embedding
- Test date filtering (7 days)
- Test similarity threshold (0.75)
- Verify results order and content

**`tests/integration/ask.test.ts`:**
- Mock RSS feeds (return sample data)
- Mock OpenRouter LLM (return structured response)
- Test full /ask endpoint flow
- Verify SSE events order and content
- Test error handling (invalid input, no results)

#### Test Database Setup

**Docker container for tests:**
```bash
docker run -d --name crypto_news_test_db \
  -e POSTGRES_USER=test_user \
  -e POSTGRES_PASSWORD=test_pass \
  -e POSTGRES_DB=crypto_news_test \
  -p 5433:5432 \
  pgvector/pgvector:pg16
```

**Before tests:** Run migrations on test DB
**After each test:** Truncate tables (or use transactions)

### 7.2 Frontend Tests (Vitest + React Testing Library)

**Config:** `frontend/vitest.config.ts`

```typescript
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: './src/test/setup.ts'
  }
});
```

**Setup:** `frontend/src/test/setup.ts`
```typescript
import '@testing-library/jest-dom';
```

#### Component Tests

**`tests/QuestionInput.test.tsx`:**
- Test form submission
- Test character counter (0/500)
- Test validation (empty, too long)
- Test disabled state
- Test Enter key submission

**`tests/StructuredAnswer.test.tsx`:**
- Test citation rendering
- Test citation click (scroll to source)
- Test confidence badge display
- Test source card rendering

#### Hook Tests

**`tests/useStreamingAnswer.test.ts`:**
- Mock fetch + SSE response
- Test state updates (metadata, sources, tokens, structured, done)
- Test error handling
- Test SSE parsing (event/data lines)

### 7.3 Test Scripts

**`backend/package.json`:**
```json
{
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "test:coverage": "vitest run --coverage",
    "test:ui": "vitest --ui"
  }
}
```

**`frontend/package.json`:** (same scripts)

### 7.4 Coverage Target

**Goal:** 80%+ for critical paths
- Ingestion pipeline
- Semantic search
- /ask endpoint
- Streaming hook

**Non-critical:** Lower priority for UI components

---

## Phase 8: Deployment (3-4h)

### 8.1 Environment Configuration

**Production .env (backend):**
```
DATABASE_URL=postgresql://user:pass@postgres:5432/crypto_news
OPENROUTER_API_KEY=sk-or-v1-...
OPENAI_API_KEY=sk-...
NODE_ENV=production
PORT=3001
FRONTEND_URL=https://your-domain.com
```

**Production .env (frontend):**
```
VITE_API_URL=https://api.your-domain.com
```

### 8.2 Easypanel Deployment Steps

**Prerequisites:**
- Easypanel account
- GitHub repository with code
- Domain name (optional)

**Steps:**

1. **Push to GitHub**
```bash
git add .
git commit -m "Production ready"
git push origin main
```

2. **Create Project in Easypanel**
- Login to Easypanel dashboard
- Create new project: "crypto-news-agent"
- Connect GitHub repository
- Select branch: `main`

3. **Configure Services**
- Easypanel auto-detects `docker-compose.yml`
- Verify 3 services: postgres, backend, frontend

4. **Set Environment Variables**
- In Easypanel dashboard, go to Settings → Environment
- Add all variables from `.env.example`
- Mark `OPENROUTER_API_KEY` and `DB_PASSWORD` as secrets

5. **Deploy**
- Click "Deploy" button
- Easypanel builds Docker images
- Runs containers with health checks
- Monitors status

6. **Run Database Migrations**
- Access backend container terminal in Easypanel
- Run: `npx prisma migrate deploy`
- Verify tables created

7. **Setup Domain (Optional)**
- In Easypanel: Settings → Domains
- Add custom domain
- Configure DNS records (A/CNAME)
- Enable HTTPS (automatic via Let's Encrypt)

8. **Monitor**
- Check health endpoint: `/health`
- View logs in Easypanel dashboard
- Monitor resource usage (CPU, memory, DB)

### 8.3 Health Checks

**Backend health check** (in Dockerfile):
```dockerfile
HEALTHCHECK --interval=30s --timeout=3s --start-period=40s \
  CMD node -e "require('http').get('http://localhost:3001/health', ...)"
```

**Frontend health check** (in Dockerfile):
```dockerfile
HEALTHCHECK --interval=30s CMD wget --quiet --tries=1 --spider http://localhost/ || exit 1
```

**PostgreSQL health check** (in docker-compose.yml):
```yaml
healthcheck:
  test: ["CMD-SHELL", "pg_isready -U crypto_agent"]
  interval: 10s
  timeout: 5s
  retries: 5
```

### 8.4 Monitoring & Logs

**Easypanel provides:**
- Real-time logs for each service
- Resource usage graphs (CPU, RAM, Network)
- Health check status
- Restart policies

**Application-level logging:**
- Use `console.log` for info
- Use `console.error` for errors
- Structured logs: `{ timestamp, level, message, metadata }`

**Monitoring endpoints:**
- `/health` - Health check
- Future: Add `/metrics` for Prometheus (optional)

---

## Timeline Summary

| Phase | Description | Estimated Time |
|-------|-------------|----------------|
| 1 | Project Setup & Configuration | 2-3 hours |
| 2 | RSS Ingestion System | 4-5 hours |
| 3 | Semantic Search & Retrieval | 3-4 hours |
| 4 | LLM Agent with Anti-Hallucination | 3-4 hours |
| 5 | API Endpoints | 3-4 hours |
| 6 | Frontend | 4-5 hours |
| 7 | Automated Testing | 4-5 hours |
| 8 | Deployment | 3-4 hours |
| **TOTAL** | | **27-35 hours** |

---

## Key Features Checklist

✅ **Fresh Data:** Fetch RSS every query, process only new articles
✅ **OpenRouter Integration:** LLM (answer generation) + Embeddings via OpenRouter
✅ **Hybrid Embeddings:** Summary + full chunks for optimal matching
✅ **Multi-Stage Retrieval:** Vector search → re-rank → deduplicate → select top 5-7
✅ **Anti-Hallucination:** Explicit prompts + required citations + confidence scoring
✅ **Content Moderation:** OpenAI Moderation API (free) with fallback keyword filter
✅ **Concurrent Handling:** Queue system prevents duplicate RSS fetches, 10 req/min rate limit
✅ **Real-Time Streaming:** SSE with token-by-token delivery, client disconnect detection
✅ **Temporal Awareness:** LLM receives current date/time in every prompt
✅ **7-Day Default:** Recent news prioritized, adjustable based on query
✅ **Clickable Citations:** Scroll to sources with highlight animation
✅ **Type Safety:** Prisma for compile-time database type checking
✅ **Edge Case Handling:** Timeouts, retry logic, graceful degradation, clear error messages
✅ **Comprehensive Tests:** 80%+ coverage with Vitest (unit + integration)
✅ **Production Ready:** Multi-stage Docker builds, health checks, error handling
✅ **Easypanel Deploy:** One-command deployment with monitoring

---

## Next Steps

1. **Review this plan** - Ensure all requirements are met
2. **Fetch API documentation** - OpenRouter (LLM + embeddings), OpenAI (moderation), Prisma, RSS Parser, pgvector
3. **Start Phase 1** - Initialize backend and frontend projects
4. **Follow phases sequentially** - Each phase builds on previous
5. **Test continuously** - Write tests alongside implementation
6. **Deploy to Easypanel** - Production deployment with monitoring

**API Key Summary:**
- `OPENROUTER_API_KEY`: LLM answer generation + text embeddings
- `OPENAI_API_KEY`: Content moderation only (free tier)

**Ready to build! 🚀**
