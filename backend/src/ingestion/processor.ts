import { Prisma } from '@prisma/client';
import { ChatOpenAI } from '@langchain/openai';
import { RawArticle } from '../types';
import { prisma } from '../utils/db';
import { generateEmbeddingsBatch, generateSummariesBatch, createOpenRouterEmbeddings } from '../agents/llm';
import { chunkArticle } from './chunker';
import { debugLogger } from '../utils/debug-logger';
import { processConcurrently, chunkArray } from '../utils/concurrency';
import { analyzeArticleForIngestion } from '../agents/analysis';

// Shared embeddings instance for title embedding generation
const titleEmbeddings = createOpenRouterEmbeddings();

// Shared LLM for analysis during ingestion
let ingestionLLM: ChatOpenAI | null = null;

function getIngestionLLM(): ChatOpenAI {
  if (!ingestionLLM) {
    ingestionLLM = new ChatOpenAI({
      modelName: 'openai/gpt-4.1-nano',
      temperature: 0,
      configuration: {
        baseURL: 'https://openrouter.ai/api/v1',
        apiKey: process.env.OPENROUTER_API_KEY,
      },
    });
  }
  return ingestionLLM;
}

export async function processArticle(
  article: RawArticle,
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
    const chunkData = await chunkArticle(article, preGeneratedSummary);
    debugLogger.stepFinish(chunkStepId, {
      chunkCount: chunkData.length,
      hasSummary: chunkData.some(c => c.isSummary)
    });

    // Step 2: Generate embeddings for chunks AND title (batch together for efficiency)
    const embeddingStepId = debugLogger.stepStart('EMBEDDING_GENERATION', 'Generating embeddings for chunks and title', {
      chunkCount: chunkData.length
    });

    // Batch title with chunks - one API call instead of separate calls
    const textsToEmbed = [...chunkData.map(c => c.content), article.title];
    const allEmbeddings = await generateEmbeddingsBatch(textsToEmbed);

    // Split embeddings: chunks and title
    const embeddings = allEmbeddings.slice(0, chunkData.length);
    const titleEmbedding = allEmbeddings[chunkData.length];

    debugLogger.stepFinish(embeddingStepId, {
      embeddingCount: embeddings.length,
      hasTitleEmbedding: !!titleEmbedding
    });

    // Step 3: Save to database
    const dbStepId = debugLogger.stepStart('DB_TRANSACTION', 'Saving article and chunks to database', {
      chunkCount: chunkData.length
    });

    await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      // Create article with title embedding using raw SQL (Prisma doesn't support vector type directly)
      const createdArticles = await tx.$queryRaw<Array<{ id: string }>>`
        INSERT INTO "Article" (id, url, title, content, summary, source, author, "publishedAt", "createdAt", "titleEmbedding")
        VALUES (
          gen_random_uuid(),
          ${article.url},
          ${article.title},
          ${article.content},
          ${chunkData.find(c => c.isSummary)?.content || null},
          ${article.source},
          ${article.author || null},
          ${article.publishedAt},
          NOW(),
          ${titleEmbedding ? `[${titleEmbedding.join(',')}]` : null}::vector
        )
        RETURNING id
      `;
      const createdArticle = { id: createdArticles[0].id };

      debugLogger.info('DB_TRANSACTION', 'Article created with title embedding', {
        articleId: createdArticle.id,
        hasTitleEmbedding: !!titleEmbedding
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

    // Step 4: Pre-analyze article for insights (non-blocking)
    const analysisStepId = debugLogger.stepStart('INGESTION_ANALYSIS', 'Pre-analyzing article for insights', {
      url: article.url
    });

    try {
      const llm = getIngestionLLM();
      const content = preGeneratedSummary || article.content;
      const insights = await analyzeArticleForIngestion(article.title, content, llm);

      // Update article with pre-computed insights
      await prisma.article.updateMany({
        where: { url: article.url },
        data: {
          sentiment: insights.sentiment,
          keyPoints: insights.keyPoints,
          entities: insights.entities,
          analyzedAt: new Date(),
        },
      });

      debugLogger.stepFinish(analysisStepId, {
        sentiment: insights.sentiment,
        keyPointsCount: insights.keyPoints.length,
        entitiesCount: insights.entities.length,
      });
    } catch (analysisError) {
      // Non-blocking - log and continue
      debugLogger.stepError(analysisStepId, 'INGESTION_ANALYSIS', 'Pre-analysis failed (non-critical)', analysisError);
    }

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
  articles: RawArticle[]
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
      const batchSummaries = await generateSummariesBatch(batch);
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
      await processArticle(article, summary);
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
