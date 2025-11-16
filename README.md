# Crypto News Agent

AI-powered crypto news agent that provides real-time answers based on the latest news from DL News, The Defiant, and Cointelegraph.

## Features

- **Real-time News Ingestion**: Automatically fetches and processes articles from 3 major crypto news sources
- **Semantic Search**: Uses pgvector for efficient similarity search with embeddings
- **Anti-Hallucination**: Strict citation requirements and confidence scoring
- **Streaming Responses**: Real-time token-by-token answers via Server-Sent Events
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

## Quick Start

### 1. Clone and Install

```bash
# Backend
cd backend
npm install

# Frontend
cd ../frontend
npm install
```

### 2. Configure Environment Variables

The `.env` files are already set up with your API keys. Verify they're correct:

**backend/.env:**
```bash
DATABASE_URL=postgresql://crypto_agent:dev_password_123@localhost:5433/crypto_news
OPENROUTER_API_KEY=sk-or-v1-...
OPENAI_API_KEY=sk-...
PORT=3001
NODE_ENV=development
FRONTEND_URL=http://localhost:5173
```

**frontend/.env:**
```bash
VITE_API_URL=http://localhost:3001
```

### 3. Start the Database

The PostgreSQL database with pgvector is already running on port 5433:

```bash
docker ps | grep crypto_news_db
```

If it's not running:
```bash
docker-compose up -d postgres
```

### 4. Run Backend

```bash
cd backend
npm run dev
```

The backend will start on `http://localhost:3001`

### 5. Run Frontend

In a new terminal:

```bash
cd frontend
npm run dev
```

The frontend will start on `http://localhost:5173`

### 6. Use the Application

1. Open `http://localhost:5173` in your browser
2. Ask a question about crypto news (e.g., "What's happening with Bitcoin?")
3. Watch as the agent:
   - Fetches latest RSS feeds
   - Performs semantic search
   - Streams an answer with citations
   - Shows sources with relevance scores

## How It Works

### Architecture Flow

```
User Question
    ↓
Fetch RSS feeds (3 sources in parallel)
    ↓
Filter for new articles
    ↓
Process new articles:
  - Generate summary (via OpenRouter LLM)
  - Chunk content (summary + intro + chunks)
  - Generate embeddings (via OpenRouter)
  - Store in PostgreSQL with pgvector
    ↓
Semantic Search:
  - Generate query embedding
  - Vector similarity search (pgvector)
  - Re-rank by relevance + recency
  - Deduplicate (best chunk per article)
  - Select top 5-7 articles
    ↓
Build context with anti-hallucination prompts
    ↓
Stream answer via OpenRouter LLM
    ↓
Display with clickable citations
```

### Key Features

**Hybrid Chunking Strategy:**
- Summary embeddings for broad topic matching
- Full chunk embeddings for detailed semantics
- Improves query-to-content similarity

**Multi-Stage Retrieval:**
1. Vector search (top 20 candidates)
2. Re-rank (similarity × recency × boosts)
3. Deduplicate (keep best chunk per article)
4. Select top 5-7 diverse articles

**Anti-Hallucination Measures:**
- Explicit "only use provided articles" prompts
- Required citations for every claim [1], [2], [3]
- Confidence scoring (1-100%)
- Temporal awareness (current date/time in prompt)
- Citation validation after generation

**Content Moderation:**
- OpenAI Moderation API (free tier)
- Checks for hate, harassment, violence, etc.
- Fallback keyword blocklist

## Database Schema

```sql
Article (id, url, title, content, summary, source, author, publishedAt)
  ├── ArticleChunk (id, articleId, chunkIndex, content, isIntro, isSummary)
      └── ArticleEmbedding (id, chunkId, embedding vector(1536))

QueryLog (id, question, articlesRetrieved, confidence, processingTimeMs)
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

## Development

### Backend Commands

```bash
npm run dev          # Start dev server with hot reload
npm run build        # Build for production
npm run start        # Start production server
npm test             # Run tests
npm run prisma:migrate  # Run database migrations
```

### Frontend Commands

```bash
npm run dev          # Start dev server
npm run build        # Build for production
npm run preview      # Preview production build
npm test             # Run tests
```

## Deployment

The app is containerized and ready for deployment:

```bash
docker-compose up -d
```

This starts:
- PostgreSQL with pgvector on port 5432
- Backend API on port 3001
- Frontend on port 80

See `docker-compose.yml` for full configuration.

## RSS Sources

1. **DL News**: https://www.dlnews.com/arc/outboundfeeds/rss/
2. **Cointelegraph**: https://cointelegraph.com/rss
3. **The Defiant**: https://thedefiant.io/api/feed

Articles are fetched on every query to ensure fresh data.

## Troubleshooting

### Database Connection Issues

```bash
# Check if database is running
docker ps | grep crypto_news_db

# View database logs
docker logs crypto_news_db

# Restart database
docker-compose restart postgres
```

### Backend Issues

```bash
# Check backend logs
cd backend
npm run dev

# Verify environment variables
cat .env
```

### Frontend Issues

```bash
# Clear cache and rebuild
cd frontend
rm -rf node_modules dist
npm install
npm run dev
```

### Port Already in Use

If port 5433 is taken, modify `docker-compose.yml`:

```yaml
ports:
  - "5434:5432"  # Change external port
```

Then update `backend/.env`:
```bash
DATABASE_URL=postgresql://crypto_agent:dev_password_123@localhost:5434/crypto_news
```

## License

MIT

## Contributing

Contributions welcome! Please open an issue or PR.
