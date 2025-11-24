# LangChain + LangGraph + LangFuse Implementation Plan

## Overview

Transform the crypto news agent into a true multi-agent system using:
- **LangChain.js 1.1.0** - Multi-agent orchestration
- **LangGraph 1.0.2** - State management and conditional workflows
- **LangFuse 4.4.2** - Observability and tracing
- **OpenRouter** - LLM provider (google/gemini-2.5-flash)

## Architecture

### Multi-Agent Design

**Agent 1: Retrieval Agent** (`src/agents/retrieval.ts`)
- Uses `search_crypto_news` tool to find relevant articles
- Generates summaries with [Source N] citations
- Structured output via Zod schema (`RetrievalOutputSchema`)

**Agent 2: Validation Agent** (`src/agents/validation.ts`)
- Uses `validate_citations` tool to verify citation accuracy
- Detects hallucinations and unsupported claims
- Assigns confidence scores (0-100)
- Structured output via Zod schema (`ValidationOutputSchema`)

**Supervisor** (`src/agents/supervisor.ts`)
- Orchestrates agents using LangGraph StateGraph
- Conditional retry logic: if confidence < 70, retry retrieval (max 1 retry)
- State management for multi-step workflows
- Returns structured `FinalResponse`

### Workflow

```
User Question
     ↓
Retrieval Agent (search → summarize → cite)
     ↓
Validation Agent (verify citations → assign confidence)
     ↓
Confidence < 70? → YES → Retry Retrieval (once)
     ↓ NO
Finalize Response
     ↓
Return to User
```

## Implementation Steps

### Phase 1: Dependencies ✅

```bash
npm install @langchain/core@^1.1.0 langchain@^1.1.0 @langchain/openai@^1.1.3 \
  @langchain/langgraph@^1.0.2 @langfuse/core@^4.4.2 @langfuse/langchain@^4.4.2 \
  @opentelemetry/api@^1.9.0 --legacy-peer-deps
```

**Version Notes:**
- Downgraded `zod` to 3.23.8 (compatibility with openai@6.9.1)
- Upgraded `openai` to 6.9.1

### Phase 2: Schemas ✅

**File:** `src/schemas/index.ts`

Define type-safe schemas for all agent outputs:
- `SourceSchema` - Article metadata
- `RetrievalOutputSchema` - Summary + sources + citation count
- `ValidationOutputSchema` - Confidence + validation results
- `FinalResponseSchema` - Complete user response

### Phase 3: LLM Wrapper ✅

**File:** `src/agents/llm.ts`

- `createOpenRouterLLM()` - ChatOpenAI instance with LangFuse auto-tracing
- `OpenRouterEmbeddings` class - Custom embeddings for qwen/qwen3-embedding-8b
- LangFuse integration via environment variables:
  - `LANGFUSE_PUBLIC_KEY`
  - `LANGFUSE_SECRET_KEY`
  - `LANGFUSE_BASE_URL`

### Phase 4: Tools ✅

**File:** `src/tools/searchNews.ts`
- Wraps existing pgvector semantic search
- Uses `DynamicStructuredTool` with simplified Zod schema
- Returns ranked, deduplicated articles with relevance scores

**File:** `src/tools/validateCitations.ts`
- Extracts [Source N] citations using regex
- Validates citation numbers against available sources
- Detects uncited claims

### Phase 5: Agents ✅

**File:** `src/agents/retrieval.ts`
- Binds `search_crypto_news` tool to LLM
- Uses `.withStructuredOutput()` for type-safe responses
- Enforces strict citation rules in system prompt

**File:** `src/agents/validation.ts`
- Binds `validate_citations` tool to LLM
- Two-step validation:
  1. Tool validates citation mechanics
  2. LLM provides final assessment with confidence score

### Phase 6: Supervisor ✅

**File:** `src/agents/supervisor.ts`

LangGraph StateGraph with 3 nodes:
1. **retrieval** - Execute retrieval agent
2. **validation** - Execute validation agent
3. **finalize** - Prepare final response

Conditional routing:
- If confidence ≥ 70: proceed to finalize
- If confidence < 70 AND retryCount < 1: retry retrieval
- Otherwise: finalize with current results

### Phase 7: API Integration ✅

**File:** `src/api/ask.ts`

Rewritten to use multi-agent supervisor:
1. Run ingestion (still uses old `OpenRouterAgent` temporarily)
2. Create LLM, embeddings, tools
3. Create agents
4. Execute supervisor workflow
5. Stream results to client

**Note:** Ingestion still uses old agent - can be migrated later

## Technical Decisions

### Structured Outputs

**Why:** Reliability and type safety
- ALL LLM responses use `.withStructuredOutput(ZodSchema)`
- No parsing errors, guaranteed type safety
- Industry standard approach

### Simplified Zod Schemas

**Why:** Avoid TypeScript deep instantiation errors
- Removed `.describe()` calls from tool schemas
- Moved descriptions to tool description string
- Used `.optional()` instead of `.default()`

### ts-node --transpile-only

**Why:** Development speed
- Skip type checking in dev mode for faster iteration
- Build step (`npm run build`) still uses `tsc` for full validation
- Common practice for complex TypeScript projects

### No Feature Flags

**Why:** Clean implementation
- Direct replacement of old logic
- Simpler codebase, easier to maintain
- Industry standard: migrate completely, don't maintain dual paths

## Configuration

### Environment Variables

```env
# OpenRouter
OPENROUTER_API_KEY=your_key

# LangFuse (auto-tracing)
LANGFUSE_PUBLIC_KEY=your_key
LANGFUSE_SECRET_KEY=your_secret
LANGFUSE_BASE_URL=https://cloud.langfuse.com

# App
APP_URL=http://localhost:3001
```

### Models Used

- **LLM:** `google/gemini-2.5-flash` (fast, cost-effective)
- **Embeddings:** `qwen/qwen3-embedding-8b` (4096 dimensions)

## Future Enhancements

### Phase 8: LangFuse Evaluators (Pending)

Create custom evaluators for:
- Citation accuracy metrics
- Hallucination detection scores
- Confidence calibration

### Phase 9: Cleanup (Pending)

- Delete `src/agents/openrouter-agent.ts`
- Migrate ingestion to use new multi-agent system
- Remove old code paths

## Testing

### Compilation

```bash
npm run dev  # Starts with --transpile-only
npm run build # Full type checking
```

### Manual Testing

```bash
curl -X POST http://localhost:3001/ask \
  -H "Content-Type: application/json" \
  -d '{"question":"What happened with Bitcoin today?"}'
```

Expected response: Server-Sent Events with:
- `event: metadata` - Query metadata
- `event: status` - Processing status
- `event: sources` - Retrieved sources
- `event: answer` - Streamed answer
- `event: structured` - Full structured response
- `event: done` - Processing complete

## Success Criteria

✅ All dependencies installed without conflicts
✅ TypeScript compilation successful
✅ Server starts without errors
✅ Multi-agent workflow architecture in place
✅ Structured outputs for all LLM responses
✅ LangFuse auto-tracing configured
✅ Conditional retry logic functional

## Known Issues

1. **Ingestion Job:** Still uses old `OpenRouterAgent`, has JSON parsing issues
   - **Impact:** Non-blocking, doesn't affect query workflow
   - **Fix:** Migrate ingestion to use structured outputs (future work)

2. **First Request Latency:** Initial LLM calls may take 10-30 seconds
   - **Impact:** User experience
   - **Mitigation:** Consider warmup requests or streaming feedback

## Notes

- LangGraph enables future scale: easy to add more agents, complex workflows
- Structured outputs eliminate JSON parsing failures
- LangFuse provides production-ready observability
- Clean separation of concerns: Tools → Agents → Supervisor → API
