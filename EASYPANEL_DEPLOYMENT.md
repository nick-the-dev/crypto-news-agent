# Easypanel Deployment Guide

This guide covers deploying the Crypto News Agent to Easypanel.

## Overview

The application is deployed as a **single service** that:
- Builds the frontend (React/Vite) as static files
- Builds the backend (Node.js/Express)
- Serves the frontend from the backend Express server
- All traffic goes through port 3001

## Prerequisites

1. Easypanel account with a project created
2. PostgreSQL database (can be created in Easypanel)
3. API keys:
   - `OPENROUTER_API_KEY` or `OPENAI_API_KEY`

## Deployment Steps

### 1. Create PostgreSQL Database Service

In Easypanel, create a new PostgreSQL service:
- **Service Type**: PostgreSQL (with pgvector extension if available)
- **Database Name**: `crypto_news`
- **Username**: `crypto_agent`
- **Password**: (generate a secure password)

Note the connection string, it will look like:
```
postgresql://crypto_agent:your_password@postgres:5432/crypto_news
```

### 2. Create Application Service

1. **Create New App** in Easypanel
2. **Source**: GitHub repository
3. **Build Method**: Dockerfile
4. **Dockerfile Path**: `./Dockerfile` (root of project)

### 3. Configure Environment Variables

Add these environment variables to your Easypanel app:

```bash
# Database (use internal connection if PostgreSQL is in same project)
DATABASE_URL=postgresql://crypto_agent:your_password@postgres:5432/crypto_news

# API Keys (use at least one)
OPENROUTER_API_KEY=your_openrouter_key
OPENAI_API_KEY=your_openai_key

# Application Settings
NODE_ENV=production
PORT=3001
```

### 4. Configure Domains

1. **Port**: Set to `3001` (the backend port)
2. **Domain**: Add your custom domain or use Easypanel subdomain
3. **HTTPS**: Enable (recommended)

### 5. Deploy

1. Click **Deploy**
2. Monitor build logs
3. Wait for health check to pass
4. Access your application at the configured domain

## Database Migrations

The Dockerfile automatically runs `prisma migrate deploy` on startup, so migrations are applied automatically.

## Health Check

The application includes a health check endpoint at `/health` that Easypanel can use to monitor the service.

## Architecture

```
┌─────────────────────────────────────┐
│     Easypanel (Single Container)    │
│  ┌───────────────────────────────┐  │
│  │   Express Server (Port 3001)  │  │
│  │  ┌─────────────────────────┐  │  │
│  │  │  Static Frontend Files  │  │  │
│  │  │  (served at /)          │  │  │
│  │  └─────────────────────────┘  │  │
│  │  ┌─────────────────────────┐  │  │
│  │  │  API Routes             │  │  │
│  │  │  - POST /ask            │  │  │
│  │  │  - GET /health          │  │  │
│  │  │  - GET /api/job-status  │  │  │
│  │  └─────────────────────────┘  │  │
│  └───────────────────────────────┘  │
└─────────────────────────────────────┘
           │
           ▼
┌─────────────────────────────────────┐
│   PostgreSQL Database (Separate)    │
│         (with pgvector)             │
└─────────────────────────────────────┘
```

## Troubleshooting

### Build Fails

- Check that all dependencies are in `package.json`
- Verify Dockerfile is in the root directory
- Check build logs for specific errors

### Database Connection Issues

- Verify `DATABASE_URL` environment variable
- Ensure PostgreSQL service is running
- Check if database has pgvector extension enabled
- For internal Easypanel services, use service name (e.g., `postgres`) instead of `localhost`

### Frontend Not Loading

- Verify frontend build completed successfully
- Check that `NODE_ENV=production` is set
- Verify the backend is serving static files (check backend/src/server.ts:26)

### API Calls Failing

- Check browser console for CORS errors
- Verify API routes are accessible at `/ask`, `/health`, etc.
- Check backend logs in Easypanel

## Monitoring

- **Logs**: Available in Easypanel dashboard
- **Health Check**: GET `/health` endpoint
- **Job Status**: GET `/api/job-status` to check background jobs

## Scaling

To scale horizontally:
1. Increase replicas in Easypanel
2. Ensure all containers use the same PostgreSQL database
3. Background jobs will run on all instances (consider implementing a distributed lock if needed)

## Alternative: Nginx Proxy (Advanced)

If you prefer separating concerns, see `Dockerfile.nginx` for an alternative approach using nginx to proxy requests to the backend.
