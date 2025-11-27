import { Request, Response } from 'express';
import { createOpenRouterLLM, createOpenRouterEmbeddings, createLangfuseHandler, flushLangfuseTraces, registerHandlerForFlush } from '../agents/llm';
import { createSearchNewsTool } from '../tools/searchNews';
import { createValidateCitationsTool } from '../tools/validateCitations';
import { createRetrievalAgent } from '../agents/retrieval';
import { createValidationAgent } from '../agents/validation';
import { createAnalysisAgent, ProgressCallback, TokenStreamCallback, checkAnalysisCacheOnly, AnalysisOutput } from '../agents/analysis';
import { createSupervisor } from '../agents/supervisor';
import { ingestionQueue } from '../ingestion';
import { ModerationService } from '../utils/moderation';
import { prisma } from '../utils/db';
import { debugLogger } from '../utils/debug-logger';
import { detectIntentFast } from '../search/intent-detector';
import { FinalResponse } from '../schemas';
import { validateUserQuestion, sanitizeForLog } from '../utils/sanitize';

/**
 * Convert AnalysisOutput to FinalResponse format
 */
function analysisToFinalResponse(output: AnalysisOutput): FinalResponse {
  const { summary, sentiment, trends, disclaimer } = output;
  const trendList = trends.length > 0 ? `\n\nKey trends: ${trends.join(', ')}` : '';
  const sentimentInfo = `\n\nMarket sentiment: ${sentiment.overall} (${sentiment.bullishPercent}% bullish, ${sentiment.bearishPercent}% bearish)`;
  const finalAnswer = `${summary}${sentimentInfo}${trendList}\n\n${disclaimer}`;

  return {
    answer: finalAnswer,
    sources: output.topSources,
    confidence: output.confidence,
    validated: true,
    metadata: {
      retriesUsed: 0,
      timestamp: new Date().toISOString(),
    },
  };
}

/**
 * Create a progress callback that streams SSE events
 */
function createProgressStreamer(res: Response, abortedRef: { value: boolean }): ProgressCallback {
  return (progress) => {
    if (abortedRef.value) return;

    const message = progress.phase === 'fetching'
      ? 'Fetching articles...'
      : progress.phase === 'analyzing'
        ? `Analyzing articles (${progress.current}/${progress.total}, ${progress.cached} cached)...`
        : 'Generating insights...';

    res.write(`event: status\n`);
    res.write(`data: ${JSON.stringify({
      message,
      progress: {
        phase: progress.phase,
        current: progress.current,
        total: progress.total,
        cached: progress.cached,
        percent: progress.total > 0 ? Math.round((progress.current / progress.total) * 100) : 0,
      }
    })}\n\n`);
  };
}

/**
 * Create a token streaming callback that sends SSE events for real-time streaming
 */
function createTokenStreamer(
  res: Response,
  abortedRef: { value: boolean },
  streamedContentRef: { value: string }
): TokenStreamCallback {
  return (token) => {
    if (abortedRef.value) return;

    // Accumulate streamed content
    streamedContentRef.value += token;

    // Send the token via SSE
    res.write(`event: token\n`);
    res.write(`data: ${JSON.stringify({ token })}\n\n`);
  };
}

export async function handleAsk(req: Request, res: Response): Promise<void> {
  const requestStepId = debugLogger.stepStart('ASK_REQUEST', 'Handling /ask request', {
    hasQuestion: !!req.body.question
  });

  const { question: rawQuestion } = req.body;

  // Input validation and sanitization
  const validation = validateUserQuestion(rawQuestion);

  if (!validation.valid) {
    debugLogger.stepError(requestStepId, 'ASK_REQUEST', `Invalid request: ${validation.error}`, null);
    res.status(400).json({ error: validation.error });
    return;
  }

  // Use sanitized question for all subsequent processing
  const question = validation.sanitized;

  // Log if suspicious patterns were detected (sanitized but flagged)
  if (validation.error) {
    debugLogger.warn('ASK_REQUEST', 'Suspicious input patterns detected and sanitized', {
      originalPreview: sanitizeForLog(rawQuestion.substring(0, 100)),
    });
  }

  debugLogger.info('ASK_REQUEST', 'Valid question received', {
    questionLength: question.length,
    questionPreview: sanitizeForLog(question.substring(0, 50)) + '...'
  });

  // Fast intent detection to check for cache opportunity
  const fastIntent = detectIntentFast(question);
  const isAnalysisQuery = fastIntent.intent === 'analysis';
  const estimatedTimeframe = fastIntent.timeframeDays || 7;

  // Check analysis cache BEFORE moderation (saves ~800ms for cached queries)
  if (isAnalysisQuery) {
    const cachedAnalysis = await checkAnalysisCacheOnly(question, estimatedTimeframe);
    if (cachedAnalysis) {
      debugLogger.info('ASK_REQUEST', 'Query cache hit - skipping moderation', {
        questionPreview: question.substring(0, 50),
        timeframe: estimatedTimeframe,
      });

      // Create LangFuse handler for cached response tracking
      const questionPreview = question.substring(0, 40).replace(/[^a-zA-Z0-9\s]/g, '').trim();
      const sessionId = `ask-${Date.now()}`;
      const langfuseHandler = createLangfuseHandler({
        sessionId,
        tags: ['crypto-news-agent', 'ask-endpoint', 'cached'],
      });

      // Record cached query as a trace
      await langfuseHandler.handleChainStart(
        { lc: 1, type: 'not_implemented', id: ['langchain', 'chains', 'sequential'] },
        { question },
        undefined,
        undefined,
        ['cached-analysis'],
        undefined,
        `Cached Analysis: ${questionPreview}`
      );

      // Set up streaming response
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');

      const startTime = Date.now();
      const result = analysisToFinalResponse(cachedAnalysis);

      // Send cached result immediately
      res.write(`event: metadata\n`);
      res.write(`data: ${JSON.stringify({
        queryTimestamp: new Date().toISOString(),
        articlesAnalyzed: cachedAnalysis.articlesAnalyzed,
        cached: true,
      })}\n\n`);

      res.write(`event: status\n`);
      res.write(`data: ${JSON.stringify({ message: "Retrieved from cache..." })}\n\n`);

      // Transform sources
      const sources = result.sources.map((s, i) => {
        let sourceName = 'unknown';
        try {
          if (s.url && s.url !== 'None' && s.url.startsWith('http')) {
            sourceName = new URL(s.url).hostname.replace('www.', '').split('.')[0];
          }
        } catch { /* keep default */ }
        return { number: i + 1, title: s.title, source: sourceName, url: s.url, publishedAt: s.publishedAt, relevance: s.relevance };
      });

      res.write(`event: sources\n`);
      res.write(`data: ${JSON.stringify(sources)}\n\n`);

      const streamingAnswer = result.answer.replace(/\[Source (\d+)\]/g, '[$1]');
      const tldrText = streamingAnswer.substring(0, streamingAnswer.indexOf('.') + 1).trim();

      res.write(`event: tldr\n`);
      res.write(`data: ${JSON.stringify({ content: tldrText })}\n\n`);

      res.write(`event: details\n`);
      res.write(`data: ${JSON.stringify({ content: streamingAnswer })}\n\n`);

      const citationMatches = streamingAnswer.match(/\[(\d+)\]/g) || [];
      const citations = citationMatches.map(m => parseInt(m.match(/\d+/)?.[0] || '0'));

      res.write(`event: structured\n`);
      res.write(`data: ${JSON.stringify({
        tldr: tldrText,
        details: { content: streamingAnswer, citations: [...new Set(citations)] },
        confidence: result.confidence,
        sources,
        metadata: { queryTimestamp: result.metadata.timestamp, articlesAnalyzed: sources.length, processingTime: Date.now() - startTime, cached: true }
      })}\n\n`);

      res.write(`event: done\n`);
      res.write(`data: ${JSON.stringify({ processingTime: Date.now() - startTime, cached: true })}\n\n`);
      res.end();

      // Close LangFuse trace
      await langfuseHandler.handleChainEnd({ answer: result.answer, confidence: result.confidence, cached: true });

      // Log cached query to database
      const processingTime = Date.now() - startTime;
      const logStepId = debugLogger.stepStart('QUERY_LOG', 'Logging cached query to database', {
        question,
        processingTime,
        cached: true,
      });
      prisma.queryLog.create({
        data: {
          question,
          articlesRetrieved: result.sources.length,
          confidence: result.confidence,
          processingTimeMs: processingTime
        }
      }).then(() => {
        debugLogger.stepFinish(logStepId, { success: true });
      }).catch(err => {
        debugLogger.stepError(logStepId, 'QUERY_LOG', 'Failed to log cached query', err);
        console.error('Failed to log cached query:', err);
      });

      debugLogger.stepFinish(requestStepId, { cached: true, processingTime });
      return;
    }
  }

  // Run moderation and DB count in parallel (saves ~800ms)
  const moderationStepId = debugLogger.stepStart('ASK_MODERATION', 'Checking content moderation', {
    questionLength: question.length
  });
  const countStepId = debugLogger.stepStart('DB_COUNT', 'Counting total articles in database', {});

  const moderationService = new ModerationService(process.env.OPENAI_API_KEY);
  const [moderation, totalArticles] = await Promise.all([
    moderationService.moderateInput(question),
    prisma.article.count(),
  ]);

  debugLogger.stepFinish(countStepId, { totalArticles });

  if (moderation.flagged) {
    debugLogger.stepFinish(moderationStepId, {
      flagged: true,
      categories: moderation.categories
    });
    debugLogger.stepError(requestStepId, 'ASK_REQUEST', 'Question flagged by moderation', null);
    res.status(400).json({
      error: 'Your question contains inappropriate content',
      details: 'Please rephrase your question respectfully.',
      categories: moderation.categories
    });
    return;
  }
  debugLogger.stepFinish(moderationStepId, { flagged: false });

  // Pause background ingestion during request processing
  ingestionQueue.pause();

  // Set up streaming
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  // Use ref object so progress callback can check abort status
  const abortedRef = { value: false };
  let streamAborted = false;
  req.on('close', () => {
    streamAborted = true;
    abortedRef.value = true;
    debugLogger.warn('ASK_REQUEST', 'Client closed connection (stream aborted)', {});
  });

  // Store handler reference for proper flushing
  let langfuseHandler: ReturnType<typeof createLangfuseHandler> | null = null;

  try {
    const startTime = Date.now();

    res.write(`event: metadata\n`);
    res.write(`data: ${JSON.stringify({
      queryTimestamp: new Date().toISOString(),
      articlesAnalyzed: totalArticles
    })}\n\n`);

    // Detect intent to provide appropriate status messaging
    const intentResult = detectIntentFast(question);
    const isAnalysisQuery = intentResult.intent === 'analysis';

    if (isAnalysisQuery) {
      res.write(`event: status\n`);
      res.write(`data: ${JSON.stringify({ message: "Analyzing market trends..." })}\n\n`);
    } else {
      res.write(`event: status\n`);
      res.write(`data: ${JSON.stringify({ message: "Searching crypto news..." })}\n\n`);
    }

    // Create a readable trace name from the question
    const questionPreview = question.substring(0, 40).replace(/[^a-zA-Z0-9\s]/g, '').trim();
    const sessionId = `ask-${Date.now()}`;
    const traceName = `Crypto News: ${questionPreview}`;

    // Initialize LangChain
    const llm = createOpenRouterLLM();
    const embeddings = createOpenRouterEmbeddings();

    // LangFuse handler options for this request
    const langfuseOptions = {
      sessionId,
      tags: ['crypto-news-agent', 'ask-endpoint'],
    };

    // Create handler for all agents (shared handler maintains sessionId)
    langfuseHandler = createLangfuseHandler(langfuseOptions);
    registerHandlerForFlush(langfuseHandler);

    // Create tools
    const searchTool = createSearchNewsTool(embeddings, llm);
    const validateTool = createValidateCitationsTool();

    // Create agents with LangFuse callbacks
    // All agents use the same handler to ensure consistent sessionId tracking
    const retrievalAgent = await createRetrievalAgent(llm, searchTool, langfuseHandler);
    const validationAgent = await createValidationAgent(llm, validateTool, langfuseHandler);
    const analysisAgent = await createAnalysisAgent(llm, langfuseHandler);

    // Create supervisor with all agents + LLM for intent detection
    const supervisor = createSupervisor(retrievalAgent, validationAgent, analysisAgent, llm);

    debugLogger.info('ASK_REQUEST', 'Executing multi-agent supervisor', {
      question,
      sessionId,
    });

    // Create progress and token streamers for analysis queries
    const progressCallback = createProgressStreamer(res, abortedRef);
    const streamedContentRef = { value: '' };
    const tokenCallback = createTokenStreamer(res, abortedRef, streamedContentRef);

    // Execute supervisor - LangFuse CallbackHandler tracks each LLM call
    const result = await supervisor(question, progressCallback, tokenCallback);

    if (streamAborted) {
      debugLogger.warn('ASK_REQUEST', 'Stream aborted before completion', {});
      return;
    }

    // Send sources - transform to frontend format
    const sources = result.sources.map((s, i) => {
      let sourceName = 'unknown';
      try {
        if (s.url && s.url !== 'None' && s.url.startsWith('http')) {
          sourceName = new URL(s.url).hostname.replace('www.', '').split('.')[0];
        }
      } catch {
        // Invalid URL, keep default
      }
      return {
        number: i + 1,
        title: s.title,
        source: sourceName,
        url: s.url,
        publishedAt: s.publishedAt,
        relevance: s.relevance
      };
    });

    debugLogger.info('ASK_REQUEST', 'Sending sources to client', {
      sourceCount: sources.length
    });

    res.write(`event: sources\n`);
    res.write(`data: ${JSON.stringify(sources)}\n\n`);

    // Transform [Source N] to [N] format for frontend
    const streamingAnswer = result.answer.replace(/\[Source (\d+)\]/g, '[$1]');

    // Split into TL;DR (first sentence) and details (full content)
    const firstSentenceEnd = streamingAnswer.indexOf('.') + 1;
    const tldrText = streamingAnswer.substring(0, firstSentenceEnd).trim();
    const detailsText = streamingAnswer;

    // Send TL;DR immediately (no fake streaming)
    res.write(`event: tldr\n`);
    res.write(`data: ${JSON.stringify({ content: tldrText })}\n\n`);

    // Send full details immediately (no fake streaming)
    res.write(`event: details\n`);
    res.write(`data: ${JSON.stringify({ content: detailsText })}\n\n`);

    // Extract citations from answer for frontend format
    const citationMatches = streamingAnswer.match(/\[(\d+)\]/g) || [];
    const citations = citationMatches.map(m => parseInt(m.match(/\d+/)?.[0] || '0'));

    // Send structured response in frontend-expected format
    res.write(`event: structured\n`);
    res.write(`data: ${JSON.stringify({
      tldr: streamingAnswer.split('.')[0] + '.',  // First sentence as TL;DR
      details: {
        content: streamingAnswer,
        citations: [...new Set(citations)]  // Unique citations
      },
      confidence: result.confidence,
      sources: sources,
      metadata: {
        queryTimestamp: result.metadata.timestamp,
        articlesAnalyzed: sources.length,
        processingTime: Date.now() - startTime
      }
    })}\n\n`);

    const processingTime = Date.now() - startTime;

    res.write(`event: done\n`);
    res.write(`data: ${JSON.stringify({ processingTime })}\n\n`);
    res.end();

    debugLogger.stepFinish(requestStepId, {
      processingTime,
      sourcesCount: result.sources.length,
      confidence: result.confidence,
      validated: result.validated,
      retriesUsed: result.metadata.retriesUsed,
    });

    // Log query to database
    const logStepId = debugLogger.stepStart('QUERY_LOG', 'Logging query to database', {
      question,
      processingTime
    });
    prisma.queryLog.create({
      data: {
        question,
        articlesRetrieved: result.sources.length,
        confidence: result.confidence,
        processingTimeMs: processingTime
      }
    }).then(() => {
      debugLogger.stepFinish(logStepId, { success: true });
    }).catch(err => {
      debugLogger.stepError(logStepId, 'QUERY_LOG', 'Failed to log query', err);
      console.error('Failed to log query:', err);
    });

  } catch (error) {
    debugLogger.stepError(requestStepId, 'ASK_REQUEST', 'Request failed with error', error);
    console.error('Error in /ask:', error);

    if (!res.headersSent) {
      res.status(500).json({ error: 'Internal server error' });
    } else {
      res.write(`event: error\n`);
      res.write(`data: ${JSON.stringify({ error: 'Processing failed' })}\n\n`);
      res.end();
    }
  } finally {
    // Resume background ingestion after request completes
    ingestionQueue.resume();

    // Flush LangFuse traces to ensure they're sent before response completes
    // IMPORTANT: Pass the actual handler to flush its internal client, not a separate instance
    if (langfuseHandler) {
      await flushLangfuseTraces(langfuseHandler).catch(() => {/* ignore flush errors */});
    }
  }
}

