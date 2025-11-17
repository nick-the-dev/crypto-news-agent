import { Prisma } from '@prisma/client';
import { RawArticle } from '../types';
import { prisma } from '../utils/db';
import { OpenRouterAgent } from '../agents/openrouter-agent';
import { chunkArticle } from './chunker';
import { debugLogger } from '../utils/debug-logger';

export async function processArticle(
  article: RawArticle,
  agent: OpenRouterAgent
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
    const chunkData = await chunkArticle(article, agent);
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

      for (let i = 0; i < chunkData.length; i++) {
        const chunk = chunkData[i];
        const embedding = embeddings[i];

        const createdChunk = await tx.articleChunk.create({
          data: {
            articleId: createdArticle.id,
            chunkIndex: chunk.chunkIndex,
            content: chunk.content,
            isIntro: chunk.isIntro,
            isSummary: chunk.isSummary
          }
        });

        await tx.$executeRaw`
          INSERT INTO "ArticleEmbedding" (id, "chunkId", embedding, "createdAt")
          VALUES (gen_random_uuid(), ${createdChunk.id}, ${Prisma.sql`${JSON.stringify(embedding)}::vector`}, NOW())
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

  const errors: string[] = [];
  let processed = 0;

  for (let i = 0; i < articles.length; i++) {
    const article = articles[i];
    debugLogger.info('PROCESS_NEW_ARTICLES', `Processing article ${i + 1}/${articles.length}`, {
      title: article.title,
      source: article.source
    });

    try {
      await processArticle(article, agent);
      processed++;
      debugLogger.info('PROCESS_NEW_ARTICLES', `Successfully processed article ${i + 1}/${articles.length}`, {
        processed,
        remaining: articles.length - (i + 1)
      });
    } catch (error) {
      const errorMsg = `${article.url}: ${error instanceof Error ? error.message : 'Unknown error'}`;
      errors.push(errorMsg);
      debugLogger.warn('PROCESS_NEW_ARTICLES', `Failed to process article ${i + 1}/${articles.length}`, {
        url: article.url,
        error: errorMsg
      });
      console.error(errorMsg);
    }
  }

  debugLogger.stepFinish(stepId, {
    total: articles.length,
    processed,
    failed: errors.length,
    errors: errors.length > 0 ? errors : undefined
  });

  return { processed, errors };
}
