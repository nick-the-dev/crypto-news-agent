import dotenv from 'dotenv';
import path from 'path';

// Load env vars before anything else
dotenv.config();
dotenv.config({ path: path.resolve(__dirname, '../.env'), override: true });
dotenv.config({ path: path.resolve(__dirname, '../../.env'), override: true });

import { LangfuseSpanProcessor } from '@langfuse/otel';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { setLangfuseTracerProvider } from '@langfuse/tracing';

/**
 * Initialize Langfuse tracing with OpenTelemetry.
 *
 * ARCHITECTURE NOTE:
 * The @langfuse/langchain CallbackHandler internally uses @langfuse/tracing
 * which creates OpenTelemetry spans. These spans need a TracerProvider with
 * the LangfuseSpanProcessor to actually send data to Langfuse.
 *
 * The CallbackHandler DOES set sessionId via span.updateTrace() - the previous
 * issue was that spans weren't being sent at all because we disabled the
 * SpanProcessor.
 *
 * This setup:
 * 1. Creates a NodeTracerProvider with LangfuseSpanProcessor
 * 2. Sets it as the Langfuse-specific TracerProvider (not global)
 * 3. Allows the CallbackHandler to create and send traces properly
 */
const spanProcessor = new LangfuseSpanProcessor({
  publicKey: process.env.LANGFUSE_PUBLIC_KEY,
  secretKey: process.env.LANGFUSE_SECRET_KEY,
  baseUrl: process.env.LANGFUSE_HOST || 'https://us.cloud.langfuse.com',
  debug: process.env.LANGFUSE_DEBUG === 'true',
});

// Create a TracerProvider specifically for Langfuse
const provider = new NodeTracerProvider({
  spanProcessors: [spanProcessor],
});

// Set as the Langfuse TracerProvider (isolated from any global OTel setup)
setLangfuseTracerProvider(provider);

// Export for potential flush operations
export { spanProcessor };

console.log('LangFuse: TracerProvider initialized with LangfuseSpanProcessor');
console.log('LangFuse config:', {
  hasPublicKey: !!process.env.LANGFUSE_PUBLIC_KEY,
  hasSecretKey: !!process.env.LANGFUSE_SECRET_KEY,
  host: process.env.LANGFUSE_HOST || 'https://us.cloud.langfuse.com',
});
