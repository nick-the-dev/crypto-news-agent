import './instrumentation'; // Must be first - initializes OpenTelemetry + LangFuse
import express from 'express';
import path from 'path';
import dotenv from 'dotenv';
import { corsMiddleware, rateLimiter, errorHandler, requestLogger } from './api/middleware';
import { handleAsk } from './api/ask';
import { healthCheck } from './api/health';
import { disconnectPrisma } from './utils/db';
import jobStatusRouter from './api/job-status';
import { startJobScheduler, gracefulShutdown } from './jobs/scheduler';

// Load .env from backend folder first, then override with root .env
dotenv.config();
dotenv.config({ path: path.resolve(__dirname, '../../.env'), override: true });

const app = express();
const PORT = parseInt(process.env.PORT || '3001', 10);

// Trust proxy - required when running behind reverse proxy (nginx, Easypanel, etc.)
// Using '1' means we trust only the first proxy (the direct one), not arbitrary proxies
// This prevents IP spoofing attacks while allowing rate limiting to work correctly
// In development (no proxy), this setting has no effect
if (process.env.NODE_ENV === 'production') {
  app.set('trust proxy', 1);
}

app.use(express.json());
app.use(corsMiddleware);
app.use(requestLogger);

// API routes
app.get('/health', healthCheck);
app.post('/ask', rateLimiter, handleAsk);
app.use('/api/job-status', jobStatusRouter);

// Serve static files from frontend build (when running in production)
if (process.env.NODE_ENV === 'production') {
  const publicPath = path.join(__dirname, '../public');
  app.use(express.static(publicPath));

  // Catch-all route for SPA - serve index.html for all non-API routes
  app.get('*', (_req, res) => {
    res.sendFile(path.join(publicPath, 'index.html'));
  });
}

app.use(errorHandler);

// Listen on all network interfaces (0.0.0.0) for Docker/production environments
const HOST = process.env.HOST || '0.0.0.0';

app.listen(PORT, HOST, () => {
  console.log(`🚀 Server running on ${HOST}:${PORT}`);
  console.log(`📊 Health check: http://localhost:${PORT}/health`);
  console.log(`📈 Job status: http://localhost:${PORT}/api/job-status`);

  // Start background job scheduler
  startJobScheduler();
});

process.on('SIGTERM', async () => {
  console.log('Shutting down gracefully...');
  await gracefulShutdown();
  await disconnectPrisma();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('Shutting down gracefully...');
  await gracefulShutdown();
  await disconnectPrisma();
  process.exit(0);
});
