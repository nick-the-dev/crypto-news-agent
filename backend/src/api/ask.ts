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

export async function handleAsk(req: Request, res: Response): Promise<void> {
  const { question } = req.body;

  if (!question || typeof question !== 'string') {
    res.status(400).json({ error: 'Question is required' });
    return;
  }

  if (question.length > 500) {
    res.status(400).json({ error: 'Question too long (max 500 chars)' });
    return;
  }

  const moderationService = new ModerationService(process.env.OPENAI_API_KEY);
  const moderation = await moderationService.moderateInput(question);

  if (moderation.flagged) {
    res.status(400).json({
      error: 'Your question contains inappropriate content',
      details: 'Please rephrase your question respectfully.',
      categories: moderation.categories
    });
    return;
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  let streamAborted = false;
  req.on('close', () => {
    streamAborted = true;
  });

  try {
    const startTime = Date.now();
    const agent = new OpenRouterAgent(process.env.OPENROUTER_API_KEY!);

    const ingestStats = await ingestionQueue.ingest(agent);

    const totalArticles = await prisma.article.count();
    res.write(`event: metadata\n`);
    res.write(`data: ${JSON.stringify({
      queryTimestamp: new Date().toISOString(),
      articlesAnalyzed: totalArticles,
      newArticlesProcessed: ingestStats.processed
    })}\n\n`);

    const daysBack = extractTimeRange(question);
    const searchResults = await retrieveRelevantArticles(question, daysBack, agent);

    if (searchResults.length === 0) {
      res.write(`event: structured\n`);
      res.write(`data: ${JSON.stringify({
        tldr: "No relevant recent crypto news found on this topic.",
        details: {
          content: "I don't have recent information about this in my news database. Try rephrasing your question or asking about a different crypto topic.",
          citations: []
        },
        context: {
          content: "This could mean the topic is very new, niche, or not covered by the sources I monitor (DL News, The Defiant, Cointelegraph).",
          citations: []
        },
        confidence: 10
      })}\n\n`);
      res.write(`event: done\n`);
      res.write(`data: ${JSON.stringify({ processingTime: Date.now() - startTime })}\n\n`);
      res.end();
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

    res.write(`event: sources\n`);
    res.write(`data: ${JSON.stringify(sources)}\n\n`);

    const context = buildContext(searchResults);
    const systemPrompt = buildSystemPrompt(new Date());
    const userPrompt = buildUserPrompt(context, question);

    res.write(`event: status\n`);
    res.write(`data: ${JSON.stringify({ message: "Generating answer..." })}\n\n`);

    let fullResponse = '';

    for await (const token of agent.streamAnswer(systemPrompt, userPrompt)) {
      if (streamAborted) break;

      fullResponse += token;
      res.write(`event: token\n`);
      res.write(`data: ${JSON.stringify({ token })}\n\n`);
    }

    const parsed = parseStructuredResponse(fullResponse);
    const validation = validateCitations(parsed, searchResults.length);

    if (!validation.valid) {
      console.warn('Citation issues:', validation.issues);
    }

    res.write(`event: structured\n`);
    res.write(`data: ${JSON.stringify({
      tldr: parsed.tldr,
      details: parsed.details,
      context: parsed.context,
      confidence: parsed.confidence
    })}\n\n`);

    const processingTime = Date.now() - startTime;

    res.write(`event: done\n`);
    res.write(`data: ${JSON.stringify({ processingTime })}\n\n`);
    res.end();

    prisma.queryLog.create({
      data: {
        question,
        articlesRetrieved: searchResults.length,
        confidence: parsed.confidence,
        processingTimeMs: processingTime
      }
    }).catch(err => console.error('Failed to log query:', err));

  } catch (error) {
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
