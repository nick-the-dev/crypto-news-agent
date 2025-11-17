# Background Job System

This document describes the automated background job system for preprocessing crypto news articles.

## Overview

The background job system automatically runs every 1 minute to:
1. Fetch articles from all RSS news sources
2. Filter for new articles (not already in database)
3. Generate AI summaries
4. Create text chunks
5. Generate embeddings for each chunk
6. Store everything in PostgreSQL

This ensures that when users ask questions, the response is nearly instant because all preprocessing is already done.

## Architecture

### Core Components

#### 1. Job Scheduler (`backend/src/jobs/scheduler.ts`)
- Uses `node-cron` to run the ingestion job every 1 minute
- Starts automatically when the server starts
- Handles graceful shutdown (waits for current job to finish)
- Prevents overlapping job executions

#### 2. News Ingestion Job (`backend/src/jobs/news-ingestion-job.ts`)
- Main job logic that runs the ingestion pipeline
- Reuses existing ingestion code from `backend/src/ingestion/`
- Tracks metrics and job status
- Implements error handling and critical failure detection

#### 3. Metrics Tracker (`backend/src/jobs/metrics-tracker.ts`)
- In-memory tracking of job statistics
- Monitors consecutive failures (critical state = 3+ failures)
- Calculates average duration and total articles/embeddings processed

#### 4. Job Status Manager (`backend/src/jobs/job-status.ts`)
- Persists job execution history to database (JobRun table)
- Provides functions to create/update/query job runs
- Tracks success/failure status and error messages

#### 5. Job Status API (`backend/src/api/job-status.ts`)
- Endpoint: `GET /api/job-status`
- Returns comprehensive job health and metrics
- Includes recent run history

## Database Schema

### JobRun Table
```sql
CREATE TABLE "JobRun" (
  id                 UUID PRIMARY KEY,
  startedAt          TIMESTAMP NOT NULL,
  completedAt        TIMESTAMP,
  status             VARCHAR NOT NULL,  -- 'RUNNING', 'SUCCESS', 'FAILED'
  articlesProcessed  INT,
  embeddingsCreated  INT,
  durationMs         INT,
  errorMessage       TEXT,
  createdAt          TIMESTAMP DEFAULT NOW()
);
```

Indexes:
- `startedAt` - for sorting recent runs
- `status` - for filtering by status

## How It Works

### Startup
1. Server starts (`backend/src/server.ts`)
2. Job scheduler initializes
3. First job runs immediately (doesn't wait for first cron tick)
4. Subsequent jobs run every 1 minute

### Job Execution Flow
```
Every 1 minute:
  ├─ Check if job is already running (skip if yes)
  ├─ Record job start (in-memory + database)
  ├─ Create OpenRouterAgent
  ├─ Run ingestion pipeline:
  │  ├─ Fetch all RSS feeds in parallel
  │  ├─ Filter for new articles (check URLs in DB)
  │  ├─ Generate summaries (batch of 5)
  │  ├─ Process articles (25 concurrent):
  │  │  ├─ Chunk content (600 words, 100 word overlap)
  │  │  ├─ Generate embeddings (batch of 100)
  │  │  └─ Save to DB (atomic transaction)
  │  └─ Return stats
  ├─ Count embeddings created (DB query)
  ├─ Record success/failure
  └─ Update job status in database
```

### User Query Flow
When a user sends a question:
1. Request reaches `/ask` endpoint
2. Ingestion runs (as before)
3. BUT: Articles already exist in DB (from background job)
4. Filter finds 0 new articles → skips processing (fast!)
5. Vector search runs immediately
6. Response streams back to user

**Result**: Near-instant responses because preprocessing is pre-done.

## Configuration

### Hardcoded Settings
- **Interval**: Every 1 minute (`*/1 * * * *`)
- **Always enabled**: Job starts automatically when server runs
- **No environment variables**: All settings are hardcoded for simplicity

### Modifying Behavior
To change job frequency, edit `CRON_EXPRESSION` in `backend/src/jobs/scheduler.ts`:
```typescript
const CRON_EXPRESSION = '*/1 * * * *'; // Every 1 minute
// Examples:
// '*/5 * * * *'  - Every 5 minutes
// '0 * * * *'    - Every hour at minute 0
// '*/15 * * * *' - Every 15 minutes
```

## Monitoring

### Job Status Endpoint
```bash
GET http://localhost:3001/api/job-status
```

Response:
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
    "id": "...",
    "startedAt": "2025-11-17T02:40:00.000Z",
    "completedAt": "2025-11-17T02:40:03.245Z",
    "status": "SUCCESS",
    "articlesProcessed": 5,
    "embeddingsCreated": 23,
    "durationMs": 3245,
    "errorMessage": null,
    "timeSinceLastRunMs": 15234
  },
  "recentRuns": [...]
}
```

### Logs
Job execution is logged with the `JOB` category:
- `🔄 Background job started`
- `✅ Background job completed: X articles, Y embeddings in Zms`
- `❌ Background job failed: <error message>`
- `🚨 CRITICAL: Background job has failed N times consecutively!`

Enable debug mode to see detailed logs:
```bash
DEBUG=true npm run dev
```

## Error Handling

### Consecutive Failure Detection
- Jobs track consecutive failures
- After **3 consecutive failures**, a critical error is logged
- Error message includes full stack trace in database
- In-memory metrics track failure patterns

### Graceful Shutdown
On `SIGTERM` or `SIGINT`:
1. Scheduler stops accepting new jobs
2. Waits up to 30 seconds for current job to finish
3. Disconnects from database
4. Exits cleanly

### Job Overlap Prevention
- Only one job can run at a time
- If a job is still running when the next tick occurs, it's skipped
- Prevents resource exhaustion from slow ingestion

## Performance Optimizations

### Existing Optimizations (Preserved)
- **Batch summary generation**: 5 articles per AI call
- **Batch embedding generation**: 100 chunks per AI call
- **Parallel article processing**: 25 concurrent articles
- **Atomic transactions**: Each article saved in single transaction

### New Optimizations
- **Removed 10-second cache**: No longer needed with background jobs
- **Queueing mechanism**: Multiple simultaneous requests share one ingestion
- **Pre-populated data**: Articles ready before user asks

## Troubleshooting

### Job Not Running
1. Check server logs for "Background job scheduler started"
2. Check `/api/job-status` endpoint
3. Verify environment variables (especially `OPENROUTER_API_KEY`)

### High Failure Rate
1. Check recent runs via `/api/job-status`
2. Look for error messages in database
3. Verify RSS feed URLs are accessible
4. Check API rate limits

### Slow Performance
1. Check average duration in `/api/job-status`
2. Enable debug mode to see bottlenecks
3. Consider reducing concurrent processing (lower than 25)
4. Check database query performance

## Future Enhancements

Possible improvements:
- Add health check notifications (email, Slack, etc.)
- Implement exponential backoff for failures
- Add job metrics dashboard
- Support manual job triggering via API
- Archive old job runs automatically
- Add more granular job statistics (per-source metrics)
