import dotenv from 'dotenv';
import path from 'path';

// Load env vars before initializing OTEL
dotenv.config();
dotenv.config({ path: path.resolve(__dirname, '../.env'), override: true });
dotenv.config({ path: path.resolve(__dirname, '../../.env'), override: true });

import { NodeSDK } from '@opentelemetry/sdk-node';
import { LangfuseSpanProcessor } from '@langfuse/otel';

// Initialize OpenTelemetry with LangFuse span processor
// This must be imported before any other modules that use LangChain
const sdk = new NodeSDK({
  spanProcessors: [new LangfuseSpanProcessor()],
});

sdk.start();

console.log('OpenTelemetry + LangFuse instrumentation initialized');
console.log('LangFuse config:', {
  hasPublicKey: !!process.env.LANGFUSE_PUBLIC_KEY,
  hasSecretKey: !!process.env.LANGFUSE_SECRET_KEY,
  baseUrl: process.env.LANGFUSE_BASE_URL || 'default',
});
