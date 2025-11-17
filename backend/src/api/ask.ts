import { Request, Response } from 'express';
import { OpenRouterAgent } from '../agents/openrouter-agent';
import { ingestionQueue } from '../ingestion';
import { retrieveRelevantArticles } from '../search/retriever';
import { buildContext } from '../search/context-builder';
import { buildSystemPrompt } from '../prompts/system-prompt';
import { buildUserPrompt } from '../prompts/user-prompt';
import { parseStructuredResponse, validateCitations } from '../utils/response-parser';
import { extractTimeRange } from '../utils/time';
import { ModerationService } from '../utils/moderation';
import { prisma } from '../utils/db';
import { debugLogger } from '../utils/debug-logger';

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
    const agent = new OpenRouterAgent(process.env.OPENROUTER_API_KEY!);

    debugLogger.info('ASK_REQUEST', 'Starting ingestion process', {});
    const ingestStats = await ingestionQueue.ingest(agent);
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

    const timeRangeStepId = debugLogger.stepStart('TIME_EXTRACTION', 'Extracting time range from question', {
      question
    });
    const daysBack = extractTimeRange(question);
    debugLogger.stepFinish(timeRangeStepId, { daysBack });

    const searchStepId = debugLogger.stepStart('SEARCH', 'Retrieving relevant articles', {
      daysBack,
      question
    });
    const searchResults = await retrieveRelevantArticles(question, daysBack, agent);
    debugLogger.stepFinish(searchStepId, {
      resultCount: searchResults.length
    });

    if (searchResults.length === 0) {
      debugLogger.warn('SEARCH', 'No relevant articles found for question', {
        question
      });
      res.write(`event: structured\n`);
      res.write(`data: ${JSON.stringify({
        tldr: "No relevant recent crypto news found on this topic.",
        details: {
          content: "I don't have recent information about this in my news database. This could mean the topic is very new, niche, or not covered by the sources I monitor (DL News, The Defiant). Try rephrasing your question or asking about a different crypto topic.",
          citations: []
        },
        confidence: 10
      })}\n\n`);
      res.write(`event: done\n`);
      res.write(`data: ${JSON.stringify({ processingTime: Date.now() - startTime })}\n\n`);
      res.end();
      debugLogger.stepFinish(requestStepId, {
        noResults: true,
        processingTime: Date.now() - startTime
      });
      return;
    }

    const sources = searchResults.map((r, i) => ({
      number: i + 1,
      title: r.article.title,
      source: r.article.source,
      url: r.article.url,
      publishedAt: r.article.publishedAt.toISOString(),
      relevance: r.relevance
    }));

    debugLogger.info('ASK_REQUEST', 'Sending sources to client', {
      sourceCount: sources.length
    });

    res.write(`event: sources\n`);
    res.write(`data: ${JSON.stringify(sources)}\n\n`);

    const contextStepId = debugLogger.stepStart('CONTEXT_BUILD', 'Building context from search results', {
      resultCount: searchResults.length
    });
    const context = buildContext(searchResults);
    debugLogger.stepFinish(contextStepId, {
      contextLength: context.length
    });

    const promptStepId = debugLogger.stepStart('PROMPT_BUILD', 'Building system and user prompts', {});
    const systemPrompt = buildSystemPrompt(new Date());
    const userPrompt = buildUserPrompt(context, question);
    debugLogger.stepFinish(promptStepId, {
      systemPromptLength: systemPrompt.length,
      userPromptLength: userPrompt.length,
      systemPrompt: systemPrompt,
      userPrompt: userPrompt
    });

    res.write(`event: status\n`);
    res.write(`data: ${JSON.stringify({ message: "Generating answer..." })}\n\n`);

    let fullResponse = '';
    let currentSection: 'none' | 'tldr' | 'details' | 'confidence' = 'none';
    let sectionContent = '';

    const streamStepId = debugLogger.stepStart('AI_STREAMING', 'Streaming AI response', {
      systemPromptLength: systemPrompt.length,
      userPromptLength: userPrompt.length
    });

    let tokenCount = 0;
    for await (const token of agent.streamAnswer(systemPrompt, userPrompt)) {
      if (streamAborted) {
        debugLogger.warn('AI_STREAMING', 'Stream aborted by client', {
          tokensStreamed: tokenCount,
          responseLength: fullResponse.length
        });
        break;
      }

      tokenCount++;
      fullResponse += token;

      const lowerToken = token.toLowerCase();
      if (lowerToken.includes('## tl;dr') || lowerToken.includes('##tl;dr')) {
        if (currentSection === 'tldr' && sectionContent) {
          res.write(`event: tldr\n`);
          res.write(`data: ${JSON.stringify({ content: sectionContent.trim() })}\n\n`);
        }
        currentSection = 'tldr';
        sectionContent = '';
      } else if (lowerToken.includes('## details')) {
        if (currentSection === 'tldr' && sectionContent) {
          res.write(`event: tldr\n`);
          res.write(`data: ${JSON.stringify({ content: sectionContent.trim() })}\n\n`);
        }
        currentSection = 'details';
        sectionContent = '';
      } else if (lowerToken.includes('## confidence')) {
        if (currentSection === 'details' && sectionContent) {
          res.write(`event: details\n`);
          res.write(`data: ${JSON.stringify({ content: sectionContent.trim() })}\n\n`);
        }
        currentSection = 'confidence';
        sectionContent = '';
      } else {
        if (currentSection === 'tldr' || currentSection === 'details') {
          sectionContent += token;
          if (currentSection === 'tldr') {
            res.write(`event: tldr\n`);
            res.write(`data: ${JSON.stringify({ content: sectionContent.trim() })}\n\n`);
          } else if (currentSection === 'details') {
            res.write(`event: details\n`);
            res.write(`data: ${JSON.stringify({ content: sectionContent.trim() })}\n\n`);
          }
        }
      }
    }

    debugLogger.stepFinish(streamStepId, {
      tokensStreamed: tokenCount,
      responseLength: fullResponse.length
    });

    const parseStepId = debugLogger.stepStart('RESPONSE_PARSE', 'Parsing structured response', {
      responseLength: fullResponse.length
    });
    const parsed = parseStructuredResponse(fullResponse);
    debugLogger.stepFinish(parseStepId, {
      hasTldr: !!parsed.tldr,
      hasDetails: !!parsed.details,
      confidence: parsed.confidence
    });

    const validationStepId = debugLogger.stepStart('CITATION_VALIDATION', 'Validating citations', {
      citationCount: parsed.details?.citations?.length || 0,
      maxCitations: searchResults.length
    });
    const validation = validateCitations(parsed, searchResults.length);
    debugLogger.stepFinish(validationStepId, {
      valid: validation.valid,
      issueCount: validation.issues?.length || 0,
      issues: validation.issues
    });

    if (!validation.valid) {
      debugLogger.warn('CITATION_VALIDATION', 'Citation validation issues found', {
        issues: validation.issues
      });
      console.warn('Citation issues:', validation.issues);
    }

    res.write(`event: structured\n`);
    res.write(`data: ${JSON.stringify({
      tldr: parsed.tldr,
      details: parsed.details,
      confidence: parsed.confidence
    })}\n\n`);

    const processingTime = Date.now() - startTime;

    res.write(`event: done\n`);
    res.write(`data: ${JSON.stringify({ processingTime })}\n\n`);
    res.end();

    debugLogger.stepFinish(requestStepId, {
      processingTime,
      articlesRetrieved: searchResults.length,
      confidence: parsed.confidence
    });

    const logStepId = debugLogger.stepStart('QUERY_LOG', 'Logging query to database', {
      question,
      processingTime
    });
    prisma.queryLog.create({
      data: {
        question,
        articlesRetrieved: searchResults.length,
        confidence: parsed.confidence,
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
