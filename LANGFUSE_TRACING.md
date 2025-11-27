# LangFuse Tracing Architecture

This document explains how LangFuse tracing works in this project and documents the critical patterns required for proper trace correlation.

## Overview

We use the `@langfuse/langchain` CallbackHandler to trace LLM calls. This handler integrates with LangChain's callback system to automatically capture:
- LLM invocations (input/output)
- Token usage
- Latency metrics
- Session correlation

## Architecture

### Key Components

1. **instrumentation.ts** - Sets up the OpenTelemetry TracerProvider with LangfuseSpanProcessor
2. **llm.ts** - Creates LangFuse CallbackHandlers with sessionId/tags configuration
3. **Agent files** (retrieval.ts, analysis.ts, validation.ts) - Use callbacks in LLM calls

### How Tracing Works

```
@langfuse/langchain CallbackHandler
         |
         v
    Uses @langfuse/tracing
         |
         v
    Creates OpenTelemetry spans
         |
         v
    LangfuseSpanProcessor (from @langfuse/otel)
         |
         v
    Sends spans to Langfuse cloud
```

## Critical Pattern: Chain vs Direct LLM Calls

### The Problem

The `@langfuse/langchain` CallbackHandler has different callback methods for chains vs direct LLM calls:

- `handleChainStart` - Called when a **chain** starts (prompt.pipe(llm).invoke())
- `handleLLMStart` - Called when an **LLM** is invoked directly (llm.invoke())

**Only `handleChainStart` calls `span.updateTrace({ sessionId, tags })`**, which links the trace to a session.

### Symptoms of the Problem

When using direct `llm.invoke()` or `llm.stream()`:
- Traces appear in LangFuse but with `SessionId: NULL`
- Tags are missing (`Tags: none`)
- Traces cannot be correlated with sessions in the Sessions view

### The Fix

**Always wrap LLM calls in a chain pattern:**

```typescript
// BAD - Direct LLM call, no sessionId in trace
const response = await llm.invoke(prompt, {
  callbacks,
  runName: 'My Operation',
});

// GOOD - Chain pattern, sessionId properly set
const promptTemplate = ChatPromptTemplate.fromTemplate(promptText);
const chain = promptTemplate.pipe(llm);
const response = await chain.invoke(
  { variable: value },
  { callbacks, runName: 'My Operation' }
);
```

### For Streaming

```typescript
// BAD
const stream = await llm.stream(prompt, { callbacks });

// GOOD
const chain = promptTemplate.pipe(llm);
const stream = await chain.stream(promptVars, { callbacks });
```

## Configuration

### Environment Variables

```env
LANGFUSE_PUBLIC_KEY=pk-lf-...
LANGFUSE_SECRET_KEY=sk-lf-...
LANGFUSE_HOST=https://us.cloud.langfuse.com
LANGFUSE_DEBUG=true  # Optional, enables debug logging
```

### Creating a Handler

```typescript
import { createLangfuseHandler } from '../agents/llm';

const langfuseHandler = createLangfuseHandler({
  sessionId: `ask-${Date.now()}`,
  tags: ['crypto-news-agent', 'ask-endpoint'],
});

// Pass to LLM calls
const response = await chain.invoke(input, {
  callbacks: [langfuseHandler],
  runName: 'Descriptive Name',
});
```

## File Reference

| File | Purpose |
|------|---------|
| `backend/src/instrumentation.ts` | OTel TracerProvider setup with LangfuseSpanProcessor |
| `backend/src/agents/llm.ts` | CallbackHandler factory and LLM creation |
| `backend/src/agents/analysis.ts` | Analysis agent with chain-pattern LLM calls |
| `backend/src/agents/retrieval.ts` | Retrieval agent (example of correct pattern) |
| `backend/src/api/ask.ts` | Creates handlers with sessionId for each request |

## Troubleshooting

### Traces Have NULL SessionId

1. Check if you're using direct `llm.invoke()` instead of chain pattern
2. Ensure `ChatPromptTemplate.pipe(llm)` is used
3. Verify callbacks are passed to the chain invocation

### No Traces Appearing

1. Check `instrumentation.ts` has LangfuseSpanProcessor enabled
2. Verify environment variables are set correctly
3. Enable `LANGFUSE_DEBUG=true` to see debug output

### Traces Appear but Not Linked to Sessions

1. Ensure `handleChainStart` is being triggered (use chain pattern)
2. Verify sessionId is set in handler options
3. Check the LangFuse Sessions view, not just Traces view
