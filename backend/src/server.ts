import express from 'express';
import path from 'path';
import dotenv from 'dotenv';
import { corsMiddleware, rateLimiter, errorHandler, requestLogger } from './api/middleware';
import { handleAsk } from './api/ask';
import { healthCheck } from './api/health';
import { disconnectPrisma } from './utils/db';
import jobStatusRouter from './api/job-status';
import { startJobScheduler, gracefulShutdown } from './jobs/scheduler';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

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
  app.get('*', (req, res) => {
    res.sendFile(path.join(publicPath, 'index.html'));
  });
}

app.use(errorHandler);

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
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
