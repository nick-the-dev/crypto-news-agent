import express from 'express';
import dotenv from 'dotenv';
import { corsMiddleware, rateLimiter, errorHandler, requestLogger } from './api/middleware';
import { handleAsk } from './api/ask';
import { healthCheck } from './api/health';
import { disconnectPrisma } from './utils/db';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

app.use(express.json());
app.use(corsMiddleware);
app.use(requestLogger);

app.get('/health', healthCheck);
app.post('/ask', rateLimiter, handleAsk);

app.use(errorHandler);

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📊 Health check: http://localhost:${PORT}/health`);
});

process.on('SIGTERM', async () => {
  console.log('Shutting down gracefully...');
  await disconnectPrisma();
  process.exit(0);
});
