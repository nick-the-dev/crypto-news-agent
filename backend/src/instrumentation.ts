import dotenv from 'dotenv';
import path from 'path';

// Load env vars before initializing OTEL
dotenv.config();
dotenv.config({ path: path.resolve(__dirname, '../.env'), override: true });
dotenv.config({ path: path.resolve(__dirname, '../../.env'), override: true });

import { NodeSDK } from '@opentelemetry/sdk-node';
import { LangfuseSpanProcessor } from '@langfuse/otel';
import { configureGlobalLogger, LogLevel } from '@langfuse/core';

// Set LangFuse log level - use DEBUG for troubleshooting span exports
// configureGlobalLogger({ level: LogLevel.DEBUG });
configureGlobalLogger({ level: LogLevel.INFO });

// Initialize OpenTelemetry with LangFuse span processor
// This must be imported before any other modules that use LangChain
// Configure explicit flush settings to ensure spans are sent promptly
const spanProcessor = new LangfuseSpanProcessor({
  flushAt: 1, // Flush after every span for debugging
  flushIntervalSeconds: 1, // Flush every second
});

const sdk = new NodeSDK({
  spanProcessors: [spanProcessor],
});

sdk.start();

console.log('OpenTelemetry + LangFuse instrumentation initialized');
console.log('LangFuse config:', {
  hasPublicKey: !!process.env.LANGFUSE_PUBLIC_KEY,
  hasSecretKey: !!process.env.LANGFUSE_SECRET_KEY,
  baseUrl: process.env.LANGFUSE_BASE_URL || 'default',
});
