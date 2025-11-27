/**
 * Backfill script to generate title embeddings for existing articles
 *
 * This enables fast semantic source ranking without API calls at query time.
 * New articles get title embeddings during ingestion; this handles existing articles.
 *
 * Usage: npx ts-node src/scripts/backfill-title-embeddings.ts
 */

import { prisma } from '../utils/db';
import { createOpenRouterEmbeddings } from '../agents/llm';

const BATCH_SIZE = 100; // Embedding API batch size per request
const PARALLEL_BATCHES = 5; // Process up to 5 batches in parallel

async function main() {
  console.log('Starting title embedding backfill...\n');

  const embeddings = createOpenRouterEmbeddings();

  // Get total count of articles without title embeddings
  const totalWithoutEmbedding = await prisma.$queryRaw<[{ count: bigint }]>`
    SELECT COUNT(*) as count FROM "Article" WHERE "titleEmbedding" IS NULL
  `;
  const total = Number(totalWithoutEmbedding[0].count);

  console.log(`Found ${total} articles without title embeddings\n`);

  if (total === 0) {
    console.log('All articles have title embeddings. Nothing to do.');
    await prisma.$disconnect();
    return;
  }

  let processed = 0;
  let failed = 0;
  const startTime = Date.now();

  // Process in batches with parallel API calls
  while (true) {
    // Fetch next set of articles for parallel processing
    const fetchSize = BATCH_SIZE * PARALLEL_BATCHES;
    const articles = await prisma.$queryRaw<Array<{ id: string; title: string }>>`
      SELECT id, title FROM "Article"
      WHERE "titleEmbedding" IS NULL
      ORDER BY "publishedAt" DESC
      LIMIT ${fetchSize}
    `;

    if (articles.length === 0) {
      break;
    }

    console.log(`Processing ${articles.length} articles in parallel batches...`);

    // Split into batches
    const batches: Array<{ id: string; title: string }[]> = [];
    for (let i = 0; i < articles.length; i += BATCH_SIZE) {
      batches.push(articles.slice(i, i + BATCH_SIZE));
    }

    try {
      // Generate embeddings for all batches in parallel
      const batchResults = await Promise.all(
        batches.map(batch => embeddings.embedDocuments(batch.map(a => a.title)))
      );

      // Update each article with its embedding
      for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
        const batch = batches[batchIdx];
        const batchEmbeddings = batchResults[batchIdx];

        for (let i = 0; i < batch.length; i++) {
          const article = batch[i];
          const embedding = batchEmbeddings[i];

          try {
            await prisma.$executeRaw`
              UPDATE "Article"
              SET "titleEmbedding" = ${`[${embedding.join(',')}]`}::vector
              WHERE id = ${article.id}
            `;
            processed++;
          } catch (err) {
            console.error(`  Failed to update ${article.title}: ${err}`);
            failed++;
          }
        }
      }

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      const remaining = total - processed - failed;
      const rate = processed / (parseFloat(elapsed) || 1);
      const eta = remaining > 0 ? (remaining / rate).toFixed(0) : 0;

      console.log(
        `Progress: ${processed}/${total} (${failed} failed) | ` +
        `Elapsed: ${elapsed}s | ETA: ${eta}s\n`
      );
    } catch (err) {
      console.error(`Batch embedding failed: ${err}`);
      failed += articles.length;
    }
  }

  const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log('\n========================================');
  console.log(`Backfill complete!`);
  console.log(`  Total processed: ${processed}`);
  console.log(`  Failed: ${failed}`);
  console.log(`  Total time: ${totalTime}s`);
  console.log(`  Avg per article: ${(parseFloat(totalTime) / processed * 1000).toFixed(0)}ms`);
  console.log('========================================\n');

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error('Backfill failed:', err);
  prisma.$disconnect();
  process.exit(1);
});
