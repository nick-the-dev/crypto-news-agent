import { Prisma } from '@prisma/client';
import { RawArticle } from '../types';
import { prisma } from '../utils/db';
import { OpenRouterAgent } from '../agents/openrouter-agent';
import { chunkArticle } from './chunker';

export async function processArticle(
  article: RawArticle,
  agent: OpenRouterAgent
): Promise<void> {
  try {
    const chunkData = await chunkArticle(article, agent);
    const embeddings = await agent.generateEmbeddings(
      chunkData.map(c => c.content)
    );

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
    });
  } catch (error) {
    console.error(`Failed to process article ${article.url}:`, error);
    throw error;
  }
}

export async function processNewArticles(
  articles: RawArticle[],
  agent: OpenRouterAgent
): Promise<{ processed: number; errors: string[] }> {
  const errors: string[] = [];
  let processed = 0;

  for (const article of articles) {
    try {
      await processArticle(article, agent);
      processed++;
    } catch (error) {
      const errorMsg = `${article.url}: ${error instanceof Error ? error.message : 'Unknown error'}`;
      errors.push(errorMsg);
      console.error(errorMsg);
    }
  }

  return { processed, errors };
}
