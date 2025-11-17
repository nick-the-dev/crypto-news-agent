# Deployment Summary

## Quick Answer: Use Dockerfile

For Easypanel, **use the Dockerfile approach** (not Nixpacks). The project is now configured for single-service deployment.

## What Changed

1. ✅ Created `/Dockerfile` - Monolithic build (frontend + backend)
2. ✅ Updated `backend/src/server.ts` - Serves frontend static files in production
3. ✅ Updated `frontend/src/hooks/useStreamingAnswer.ts` - Uses relative API URLs in production
4. ✅ Updated `backend/src/api/middleware.ts` - Fixed CORS for monolithic deployment
5. ✅ Created `/.dockerignore` - Optimizes build size

## Deployment Options

### Option 1: Express Serves Everything (Recommended) ⭐

**File**: `Dockerfile`

**How it works**:
- Frontend builds to static files
- Backend Express serves frontend at `/`
- API endpoints at `/ask`, `/health`, `/api/*`
- Single port: `3001`

**Pros**:
- Simplest setup
- Single container
- No reverse proxy needed

**Use in Easypanel**:
```
Build Method: Dockerfile
Dockerfile Path: ./Dockerfile
Port: 3001
```

### Option 2: Nginx with Backend Proxy

**File**: `Dockerfile.nginx`

**How it works**:
- Nginx serves frontend on port 80
- Nginx proxies API calls to backend on 3001
- Both run in same container

**Pros**:
- Better for serving static files
- Familiar nginx patterns

**Use in Easypanel**:
```
Build Method: Dockerfile
Dockerfile Path: ./Dockerfile.nginx
Port: 80
```

## Environment Variables Needed

```bash
DATABASE_URL=postgresql://user:pass@host:5432/dbname
OPENROUTER_API_KEY=your_key  # or OPENAI_API_KEY
NODE_ENV=production
PORT=3001
```

## Testing Locally

Build and run the monolithic container:

```bash
# Build
docker build -t crypto-news-agent .

# Run (requires PostgreSQL)
docker run -p 3001:3001 \
  -e DATABASE_URL=postgresql://... \
  -e OPENROUTER_API_KEY=... \
  -e NODE_ENV=production \
  crypto-news-agent
```

Then visit: http://localhost:3001

## Nixpacks vs Dockerfile

**Why Dockerfile is better for this project**:
- ❌ Nixpacks auto-detection struggles with monorepos
- ❌ Cannot easily combine frontend + backend builds
- ✅ Dockerfile gives full control over build process
- ✅ Multi-stage builds reduce final image size
- ✅ Explicit dependency management

## Next Steps

1. Push changes to GitHub
2. Create PostgreSQL service in Easypanel
3. Create app service using Dockerfile
4. Set environment variables
5. Deploy!

See `EASYPANEL_DEPLOYMENT.md` for detailed step-by-step instructions.
