/**
 * Backfill script to analyze all existing articles missing analyzedAt
 *
 * This eliminates the cold-start latency for articles that were ingested
 * before the pre-analysis feature was added.
 *
 * Usage: npx ts-node src/scripts/backfill-analysis.ts
 */

import { ChatOpenAI } from '@langchain/openai';
import { prisma } from '../utils/db';
import { analyzeArticleForIngestion } from '../agents/analysis';
import { processConcurrently } from '../utils/concurrency';

const BATCH_SIZE = 50;
const CONCURRENCY = 10;

async function main() {
  console.log('Starting backfill analysis...\n');

  // Create LLM for analysis
  const llm = new ChatOpenAI({
    modelName: 'openai/gpt-4.1-nano',
    temperature: 0,
    configuration: {
      baseURL: 'https://openrouter.ai/api/v1',
      apiKey: process.env.OPENROUTER_API_KEY,
    },
  });

  // Get total count of unanalyzed articles
  const totalUnanalyzed = await prisma.article.count({
    where: { analyzedAt: null },
  });

  console.log(`Found ${totalUnanalyzed} articles without analysis\n`);

  if (totalUnanalyzed === 0) {
    console.log('All articles are already analyzed. Nothing to do.');
    await prisma.$disconnect();
    return;
  }

  let processed = 0;
  let failed = 0;
  const startTime = Date.now();

  // Process in batches to avoid memory issues
  while (true) {
    // Fetch next batch of unanalyzed articles
    const articles = await prisma.article.findMany({
      where: { analyzedAt: null },
      select: {
        id: true,
        title: true,
        content: true,
        summary: true,
      },
      take: BATCH_SIZE,
      orderBy: { publishedAt: 'desc' },
    });

    if (articles.length === 0) {
      break;
    }

    console.log(`Processing batch of ${articles.length} articles...`);

    // Process batch concurrently
    const result = await processConcurrently(
      articles,
      async (article) => {
        // Use summary if available, otherwise use content
        const contentForAnalysis = article.summary || article.content;
        const insights = await analyzeArticleForIngestion(
          article.title,
          contentForAnalysis,
          llm
        );

        // Update article with insights
        await prisma.article.update({
          where: { id: article.id },
          data: {
            sentiment: insights.sentiment,
            keyPoints: insights.keyPoints,
            entities: insights.entities,
            analyzedAt: new Date(),
          },
        });

        return insights;
      },
      { concurrency: CONCURRENCY, label: 'Backfill' }
    );

    processed += result.successful.length;
    failed += result.failed.length;

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const remaining = totalUnanalyzed - processed - failed;
    const rate = processed / (parseFloat(elapsed) || 1);
    const eta = remaining > 0 ? (remaining / rate).toFixed(0) : 0;

    console.log(
      `Progress: ${processed}/${totalUnanalyzed} (${failed} failed) | ` +
      `Elapsed: ${elapsed}s | ETA: ${eta}s\n`
    );

    // Log any failures
    if (result.failed.length > 0) {
      for (const f of result.failed) {
        console.error(`  Failed: ${articles[f.index]?.title} - ${f.error.message}`);
      }
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
