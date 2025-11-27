import dotenv from 'dotenv';
import path from 'path';

// Load env vars before anything else
dotenv.config();
dotenv.config({ path: path.resolve(__dirname, '../.env'), override: true });
dotenv.config({ path: path.resolve(__dirname, '../../.env'), override: true });

// OpenTelemetry instrumentation is DISABLED to avoid conflicts with LangChain CallbackHandler
// Using only @langfuse/langchain CallbackHandler ensures proper sessionId tracking
// import { LangfuseSpanProcessor } from '@langfuse/otel';
// import { NodeSDK } from '@opentelemetry/sdk-node';

// Export null to maintain compatibility
export const spanProcessor = null;

console.log('LangFuse: Using LangChain CallbackHandler only (OTel disabled)');
console.log('LangFuse config:', {
  hasPublicKey: !!process.env.LANGFUSE_PUBLIC_KEY,
  hasSecretKey: !!process.env.LANGFUSE_SECRET_KEY,
  host: process.env.LANGFUSE_HOST || 'https://us.cloud.langfuse.com',
});
