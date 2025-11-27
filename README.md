# Crypto News Agent

AI-powered crypto news agent that provides real-time answers based on the latest news from DL News, The Defiant, and Cointelegraph.

## Features

- **Real-time News Ingestion**: Automatically fetches and processes articles from 3 major crypto news sources
- **Multi-Agent Architecture**: LangGraph-based supervisor with specialized retrieval, validation, and analysis agents
- **Hybrid Search Pipeline**: 4-stage retrieval (query rewriting → hybrid vector+lexical search → reranking → confidence assessment)
- **Anti-Hallucination**: Strict citation requirements, validation agent, and confidence scoring
- **Streaming Responses**: Real-time token-by-token answers via Server-Sent Events
- **LLM Observability**: Full tracing with LangFuse for debugging and monitoring
- **Security Hardened**: OWASP Top 10 compliant with helmet, rate limiting, input sanitization
- **Modern Stack**: TypeScript, React, Node.js, PostgreSQL, Prisma, Tailwind CSS

## Tech Stack

### Backend
- **Runtime**: Node.js with TypeScript
- **Framework**: Express.js
- **Database**: PostgreSQL 16 with pgvector extension
- **ORM**: Prisma
- **LLM**: OpenRouter (Google Gemini 2.5 Flash)
- **Embeddings**: OpenRouter (Qwen3 Embedding 0.6b)
- **Moderation**: OpenAI Moderation API

### Frontend
- **Framework**: React 18 with TypeScript
- **Build Tool**: Vite
- **Styling**: Tailwind CSS
- **HTTP**: Native Fetch API with SSE

## Prerequisites

- Node.js 20+
- Docker and Docker Compose
- OpenRouter API key ([Get one here](https://openrouter.ai/))
- OpenAI API key ([Get one here](https://platform.openai.com/api-keys))

## First-Time Setup

### 1. Install Dependencies

```bash
npm run install:all  # Installs dependencies for root, backend, and frontend
```

### 2. Configure Environment Variables

Create `backend/.env`:
```bash
DATABASE_URL=postgresql://crypto_agent:dev_password_123@localhost:5433/crypto_news
OPENROUTER_API_KEY=sk-or-v1-...
OPENAI_API_KEY=sk-...
PORT=3001
FRONTEND_URL=http://localhost:5173
```

Create `frontend/.env`:
```bash
VITE_API_URL=http://localhost:3001
```

### 3. Initialize Database

Start the PostgreSQL database with pgvector extension (runs on port 5433):
```bash
docker-compose up -d postgres
```

Run Prisma migrations to create the database schema:
```bash
cd backend
npm run prisma:migrate
```

This creates the tables: `Article`, `ArticleChunk`, `ArticleEmbedding`, `QueryLog`, and `JobRun`.

### 4. Start the Application

```bash
npm run dev  # Starts backend (port 3001) and frontend (port 5173)
```

## Quick Start

After initial setup, you can start the application with:

```bash
npm run dev  # Start backend (port 3001) and frontend (port 5173)
```

### Using the Application

1. Open `http://localhost:5173` in your browser
2. Ask a question about crypto news (e.g., "What's happening with Bitcoin?")
3. Watch as the agent:
   - Fetches latest RSS feeds
   - Performs semantic search
   - Streams an answer with citations
   - Shows sources with relevance scores

## How It Works

**Flow:** User Question → Fetch RSS (3 sources) → Filter new articles → Process (summarize, chunk, embed, store) → Semantic search (vector similarity + re-rank) → Build context → Stream answer with citations

**Key Features:**
- **Hybrid Chunking**: Summary + full chunk embeddings for better matching
- **Multi-Stage Retrieval**: Vector search → re-rank by relevance/recency → deduplicate → select top 5-7
- **Anti-Hallucination**: Strict citation requirements, confidence scoring, temporal awareness, citation validation
- **Content Moderation**: OpenAI Moderation API with keyword fallback

## Background Processing

The application automatically ingests and processes crypto news articles via a background cron job:

- **Frequency**: Runs every 1 minute
- **Auto-start**: Begins automatically when the backend server starts
- **Processing Pipeline**:
  1. Fetches articles from all 3 RSS sources (DL News, The Defiant, Cointelegraph)
  2. Filters for new articles (checks against database)
  3. Generates AI summaries
  4. Creates text chunks (600 words, 100 word overlap)
  5. Generates embeddings (batch of 100 chunks)
  6. Stores everything in PostgreSQL

**Benefits**: User queries return near-instant responses because all preprocessing (summarization, chunking, embeddings) is already completed in the background.

**Monitoring**: Check job health and metrics via `GET /api/job-status`

## Database Schema

```sql
Article (id, url, title, content, summary, source, author, publishedAt)
  ├── ArticleChunk (id, articleId, chunkIndex, content, isIntro, isSummary)
      └── ArticleEmbedding (id, chunkId, embedding vector(1024))

QueryLog (id, question, articlesRetrieved, confidence, processingTimeMs)

JobRun (id, startedAt, completedAt, status, articlesProcessed, embeddingsCreated, durationMs, errorMessage)
```

## API Endpoints

### POST /ask
Ask a question about crypto news

**Request:**
```json
{
  "question": "What's happening with Bitcoin ETFs?"
}
```

**Response:** Server-Sent Events (SSE)
- `metadata`: Query timestamp, articles analyzed
- `sources`: List of relevant articles
- `status`: Processing status updates
- `token`: Streaming answer tokens
- `structured`: Parsed response (TL;DR, Details, Context, Confidence)
- `done`: Processing complete

### GET /health
Health check endpoint

**Response:**
```json
{
  "status": "healthy",
  "database": "connected",
  "totalArticles": 150,
  "latestArticle": "2025-11-16T20:30:00.000Z",
  "timestamp": "2025-11-16T22:15:00.000Z"
}
```

### GET /api/job-status
Background job monitoring endpoint

**Response:**
```json
{
  "healthy": true,
  "scheduler": {
    "running": true,
    "cronExpression": "*/1 * * * *",
    "description": "Runs every 1 minute",
    "currentlyExecuting": false
  },
  "stats": {
    "totalRuns": 42,
    "successfulRuns": 40,
    "failedRuns": 2,
    "consecutiveFailures": 0,
    "averageDurationMs": 3245
  },
  "lastRun": {
    "startedAt": "2025-11-17T02:40:00.000Z",
    "completedAt": "2025-11-17T02:40:03.245Z",
    "status": "SUCCESS",
    "articlesProcessed": 5,
    "embeddingsCreated": 23,
    "durationMs": 3245
  }
}
```

## Development

### Debug Mode

Enable detailed logging for all operations:

```bash
DEBUG=true npm run dev
```

Logs include: ASK_REQUEST, INGESTION, RSS_FETCH_*, PROCESS_ARTICLE, EMBEDDING_GENERATION, VECTOR_SEARCH, AI_STREAMING, CITATION_VALIDATION

### Commands

**Backend:**
```bash
npm run dev          # Dev server with hot reload
npm run build        # Production build
npm run start        # Production server
npm run prisma:migrate  # Database migrations
```

**Frontend:**
```bash
npm run dev          # Dev server
npm run build        # Production build
npm run preview      # Preview production build
```

## RSS Sources

1. **DL News**: https://www.dlnews.com/arc/outboundfeeds/rss/
2. **The Defiant**: https://thedefiant.io/api/feed
3. **Cointelegraph**: https://cointelegraph.com/rss

Articles are fetched automatically every minute via background jobs.

## Security

The application implements OWASP Top 10 security best practices:

- **Security Headers**: Helmet middleware (CSP, HSTS, X-Frame-Options, X-Content-Type-Options)
- **Rate Limiting**: 10 requests/minute per IP
- **Input Sanitization**: Protection against SQL injection, XSS, prompt injection, ReDoS
- **Content Moderation**: OpenAI Moderation API with keyword fallback
- **JSON Body Limits**: 10kb max to prevent DoS
- **Optional API Key Auth**: Set `API_KEY` env var to require `X-API-Key` header

## Observability

LLM calls are traced with [LangFuse](https://langfuse.com):

- Full request tracing with session correlation
- Token usage and latency metrics
- Multi-agent workflow visualization

Configure in `.env`:
```bash
LANGFUSE_PUBLIC_KEY=pk-lf-...
LANGFUSE_SECRET_KEY=sk-lf-...
```

## Troubleshooting

**Database:** `docker ps | grep crypto_news_db` → `docker-compose restart postgres`

**Port conflict:** Modify `docker-compose.yml` ports to `5434:5432` and update `DATABASE_URL` in `backend/.env`

**Clear cache:** `cd frontend && rm -rf node_modules dist && npm install`

## License

MIT

## Contributing

Contributions welcome! Please open an issue or PR.
