import { Prisma } from '@prisma/client';
import { RawArticle } from '../types';
import { prisma } from '../utils/db';
import { OpenRouterAgent } from '../agents/openrouter-agent';
import { chunkArticle } from './chunker';
import { debugLogger } from '../utils/debug-logger';
import { processConcurrently, chunkArray } from '../utils/concurrency';

export async function processArticle(
  article: RawArticle,
  agent: OpenRouterAgent,
  preGeneratedSummary?: string
): Promise<void> {
  const stepId = debugLogger.stepStart('PROCESS_ARTICLE', `Processing article: ${article.title}`, {
    url: article.url,
    source: article.source,
    contentLength: article.content.length
  });

  try {
    // Step 1: Chunk article
    const chunkStepId = debugLogger.stepStart('ARTICLE_CHUNKING', 'Chunking article content', {
      url: article.url
    });
    const chunkData = await chunkArticle(article, agent, preGeneratedSummary);
    debugLogger.stepFinish(chunkStepId, {
      chunkCount: chunkData.length,
      hasSummary: chunkData.some(c => c.isSummary)
    });

    // Step 2: Generate embeddings
    const embeddingStepId = debugLogger.stepStart('EMBEDDING_GENERATION', 'Generating embeddings for chunks', {
      chunkCount: chunkData.length
    });
    const embeddings = await agent.generateEmbeddings(
      chunkData.map(c => c.content)
    );
    debugLogger.stepFinish(embeddingStepId, {
      embeddingCount: embeddings.length
    });

    // Step 3: Save to database
    const dbStepId = debugLogger.stepStart('DB_TRANSACTION', 'Saving article and chunks to database', {
      chunkCount: chunkData.length
    });

    await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      // Create article
      const createdArticle = await tx.article.create({
        data: {
          url: article.url,
          title: article.title,
          content: article.content,
          summary: chunkData.find(c => c.isSummary)?.content || null,
          source: article.source,
          author: article.author,
          publishedAt: article.publishedAt
        }
      });

      debugLogger.info('DB_TRANSACTION', 'Article created', {
        articleId: createdArticle.id
      });

      // Batch create chunks
      await tx.articleChunk.createMany({
        data: chunkData.map(chunk => ({
          articleId: createdArticle.id,
          chunkIndex: chunk.chunkIndex,
          content: chunk.content,
          isIntro: chunk.isIntro,
          isSummary: chunk.isSummary
        }))
      });

      // Fetch created chunks to get their IDs (ordered by chunkIndex)
      const createdChunks = await tx.articleChunk.findMany({
        where: { articleId: createdArticle.id },
        orderBy: { chunkIndex: 'asc' }
      });

      // Batch insert embeddings using raw SQL
      if (createdChunks.length > 0) {
        // Build VALUES clauses for all embeddings
        const values = createdChunks.map((chunk, i) => {
          const embedding = embeddings[i];
          return Prisma.sql`(gen_random_uuid(), ${chunk.id}, ${Prisma.sql`${JSON.stringify(embedding)}::vector`}, NOW())`;
        });

        // Execute single INSERT with all values
        await tx.$executeRaw`
          INSERT INTO "ArticleEmbedding" (id, "chunkId", embedding, "createdAt")
          VALUES ${Prisma.join(values)}
        `;
      }

      debugLogger.info('DB_TRANSACTION', 'All chunks and embeddings saved', {
        chunkCount: chunkData.length
      });
    });

    debugLogger.stepFinish(dbStepId, {
      chunksStored: chunkData.length,
      embeddingsStored: embeddings.length
    });

    debugLogger.stepFinish(stepId, {
      url: article.url,
      chunksCreated: chunkData.length
    });
  } catch (error) {
    debugLogger.stepError(stepId, 'PROCESS_ARTICLE', `Failed to process article: ${article.url}`, error);
    console.error(`Failed to process article ${article.url}:`, error);
    throw error;
  }
}

export async function processNewArticles(
  articles: RawArticle[],
  agent: OpenRouterAgent
): Promise<{ processed: number; errors: string[] }> {
  const stepId = debugLogger.stepStart('PROCESS_NEW_ARTICLES', 'Processing all new articles', {
    articleCount: articles.length
  });

  if (articles.length === 0) {
    debugLogger.stepFinish(stepId, { total: 0, processed: 0, failed: 0 });
    return { processed: 0, errors: [] };
  }

  // Step 1: Pre-generate summaries in batches for all articles
  const summaryStepId = debugLogger.stepStart('BATCH_SUMMARY_GENERATION', 'Generating summaries in batches', {
    articleCount: articles.length
  });

  const summaryMap = new Map<string, string>();
  const SUMMARY_BATCH_SIZE = 5; // Reduced from 10 to 5 for more reliable JSON generation
  const articleBatches = chunkArray(articles, SUMMARY_BATCH_SIZE);

  for (let i = 0; i < articleBatches.length; i++) {
    const batch = articleBatches[i];
    debugLogger.info('BATCH_SUMMARY_GENERATION', `Processing batch ${i + 1}/${articleBatches.length}`, {
      batchSize: batch.length
    });

    try {
      const batchSummaries = await agent.generateSummariesBatch(batch);
      // Merge batch summaries into the main map
      for (const [url, summary] of batchSummaries.entries()) {
        summaryMap.set(url, summary);
      }
    } catch (error) {
      debugLogger.warn('BATCH_SUMMARY_GENERATION', `Batch ${i + 1} failed, using fallbacks`, {
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      // Use fallback summaries for this batch
      for (const article of batch) {
        if (!summaryMap.has(article.url)) {
          summaryMap.set(article.url, article.content.substring(0, 300) + '...');
        }
      }
    }
  }

  debugLogger.stepFinish(summaryStepId, {
    totalSummaries: summaryMap.size,
    batches: articleBatches.length
  });

  // Step 2: Process articles concurrently with pre-generated summaries
  const CONCURRENCY = 25; // Process 25 articles in parallel
  const result = await processConcurrently(
    articles,
    async (article) => {
      const summary = summaryMap.get(article.url);
      await processArticle(article, agent, summary);
    },
    { concurrency: CONCURRENCY, label: 'Article Processing' }
  );

  const errors = result.failed.map(
    f => `${articles[f.index]?.url}: ${f.error.message}`
  );

  debugLogger.stepFinish(stepId, {
    total: articles.length,
    processed: result.successful.length,
    failed: result.failed.length,
    errors: errors.length > 0 ? errors : undefined
  });

  return {
    processed: result.successful.length,
    errors
  };
}
