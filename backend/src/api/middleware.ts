import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { Request, Response, NextFunction } from 'express';

// CORS configuration
// In production (monolithic deployment), same-origin so CORS not needed
// In development, allow localhost frontend
export const corsMiddleware = cors({
  origin: process.env.FRONTEND_URL ||
    (process.env.NODE_ENV === 'production' ? true : 'http://localhost:5173'),
  credentials: true
});

export const rateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { error: 'Too many requests, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
  // Acknowledge that we trust the proxy headers (X-Forwarded-For)
  // This is required when app.set('trust proxy', true) is used
  trustProxy: true
});

export function errorHandler(
  err: Error & { status?: number },
  _req: Request,
  res: Response,
  _next: NextFunction
): void {
  console.error('Error:', err);

  res.status(err.status || 500).json({
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
}

export function requestLogger(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const start = Date.now();

  res.on('finish', () => {
    const duration = Date.now() - start;
    console.log(`${req.method} ${req.path} - ${res.statusCode} - ${duration}ms`);
  });

  next();
}
