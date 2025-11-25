import { Request, Response } from 'express';
import { createOpenRouterLLM, createOpenRouterEmbeddings, createLangfuseHandler } from '../agents/llm';
import { createSearchNewsTool } from '../tools/searchNews';
import { createValidateCitationsTool } from '../tools/validateCitations';
import { createRetrievalAgent } from '../agents/retrieval';
import { createValidationAgent } from '../agents/validation';
import { createSupervisor } from '../agents/supervisor';
import { ingestionQueue } from '../ingestion';
import { ModerationService } from '../utils/moderation';
import { prisma } from '../utils/db';
import { debugLogger } from '../utils/debug-logger';
import { OpenRouterAgent } from '../agents/openrouter-agent';

export async function handleAsk(req: Request, res: Response): Promise<void> {
  const requestStepId = debugLogger.stepStart('ASK_REQUEST', 'Handling /ask request', {
    hasQuestion: !!req.body.question
  });

  const { question } = req.body;

  // Validation
  if (!question || typeof question !== 'string') {
    debugLogger.stepError(requestStepId, 'ASK_REQUEST', 'Invalid request: question missing or invalid type', null);
    res.status(400).json({ error: 'Question is required' });
    return;
  }

  if (question.length > 500) {
    debugLogger.stepError(requestStepId, 'ASK_REQUEST', 'Invalid request: question too long', null);
    res.status(400).json({ error: 'Question too long (max 500 chars)' });
    return;
  }

  debugLogger.info('ASK_REQUEST', 'Valid question received', {
    questionLength: question.length,
    questionPreview: question.substring(0, 50) + '...'
  });

  // Moderation
  const moderationStepId = debugLogger.stepStart('ASK_MODERATION', 'Checking content moderation', {
    questionLength: question.length
  });
  const moderationService = new ModerationService(process.env.OPENAI_API_KEY);
  const moderation = await moderationService.moderateInput(question);

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

  // Set up streaming
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  let streamAborted = false;
  req.on('close', () => {
    streamAborted = true;
    debugLogger.warn('ASK_REQUEST', 'Client closed connection (stream aborted)', {});
  });

  try {
    const startTime = Date.now();

    // Run ingestion (still using old agent for now)
    const oldAgent = new OpenRouterAgent(process.env.OPENROUTER_API_KEY!);
    debugLogger.info('ASK_REQUEST', 'Starting ingestion process', {});
    const ingestStats = await ingestionQueue.ingest(oldAgent);
    debugLogger.info('ASK_REQUEST', 'Ingestion completed', ingestStats);

    const countStepId = debugLogger.stepStart('DB_COUNT', 'Counting total articles in database', {});
    const totalArticles = await prisma.article.count();
    debugLogger.stepFinish(countStepId, { totalArticles });

    res.write(`event: metadata\n`);
    res.write(`data: ${JSON.stringify({
      queryTimestamp: new Date().toISOString(),
      articlesAnalyzed: totalArticles,
      newArticlesProcessed: ingestStats.processed
    })}\n\n`);

    res.write(`event: status\n`);
    res.write(`data: ${JSON.stringify({ message: "Analyzing crypto news..." })}\n\n`);

    // Create a readable trace name from the question
    const questionPreview = question.substring(0, 40).replace(/[^a-zA-Z0-9\s]/g, '').trim();
    const sessionId = `ask-${Date.now()}`;
    const traceName = `Crypto News: ${questionPreview}`;

    // Initialize LangChain
    const llm = createOpenRouterLLM();
    const embeddings = createOpenRouterEmbeddings();

    // Create LangFuse handler - auto-links to active observation context
    const langfuseHandler = createLangfuseHandler({
      sessionId,
      tags: ['crypto-news-agent', 'ask-endpoint'],
    });

    // Create tools
    const searchTool = createSearchNewsTool(embeddings);
    const validateTool = createValidateCitationsTool();

    // Create agents with LangFuse callbacks
    const retrievalAgent = await createRetrievalAgent(llm, searchTool, langfuseHandler);
    const validationAgent = await createValidationAgent(llm, validateTool, langfuseHandler);

    // Create supervisor
    const supervisor = createSupervisor(retrievalAgent, validationAgent);

    debugLogger.info('ASK_REQUEST', 'Executing multi-agent supervisor', {
      question,
      traceName,
      sessionId,
    });

    // Execute supervisor - LangFuse CallbackHandler tracks each LLM call
    const result = await supervisor(question);

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

    // Send answer (simulating streaming for UX)
    res.write(`event: status\n`);
    res.write(`data: ${JSON.stringify({ message: "Generating answer..." })}\n\n`);

    // Transform [Source N] to [N] format for frontend streaming
    const streamingAnswer = result.answer.replace(/\[Source (\d+)\]/g, '[$1]');

    // Split into TL;DR (first sentence) and details (full content)
    const firstSentenceEnd = streamingAnswer.indexOf('.') + 1;
    const tldrText = streamingAnswer.substring(0, firstSentenceEnd).trim();
    const detailsText = streamingAnswer;

    // Stream TL;DR first
    const tldrWords = tldrText.split(' ');
    let tldrContent = '';
    for (let i = 0; i < tldrWords.length; i++) {
      if (streamAborted) break;
      tldrContent += (i > 0 ? ' ' : '') + tldrWords[i];
      res.write(`event: tldr\n`);
      res.write(`data: ${JSON.stringify({ content: tldrContent })}\n\n`);
      await new Promise(resolve => setTimeout(resolve, 25));
    }

    // Stream details (full answer)
    const detailsWords = detailsText.split(' ');
    let detailsContent = '';
    for (let i = 0; i < detailsWords.length; i++) {
      if (streamAborted) break;
      detailsContent += (i > 0 ? ' ' : '') + detailsWords[i];
      res.write(`event: details\n`);
      res.write(`data: ${JSON.stringify({ content: detailsContent })}\n\n`);
      await new Promise(resolve => setTimeout(resolve, 20));
    }

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
  }
}
