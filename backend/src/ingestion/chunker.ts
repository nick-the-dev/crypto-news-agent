import { ArticleChunkData, RawArticle } from '../types';
import { OpenRouterAgent } from '../agents/openrouter-agent';

const CHUNK_SIZE = 600;
const OVERLAP_SIZE = 100;
const MIN_CHUNK_SIZE = 50;

function splitIntoWords(text: string): string[] {
  return text.split(/\s+/).filter(w => w.length > 0);
}

function wordsToText(words: string[]): string {
  return words.join(' ');
}

export async function chunkArticle(
  article: RawArticle,
  agent: OpenRouterAgent
): Promise<ArticleChunkData[]> {
  const chunks: ArticleChunkData[] = [];

  const summary = await agent.generateSummary(article);
  chunks.push({
    chunkIndex: 0,
    content: summary,
    isIntro: true,
    isSummary: true
  });

  const words = splitIntoWords(article.content);

  if (words.length <= CHUNK_SIZE) {
    chunks.push({
      chunkIndex: 1,
      content: `${article.title}\n\n${wordsToText(words)}`,
      isIntro: true,
      isSummary: false
    });
    return chunks;
  }

  const introWords = words.slice(0, CHUNK_SIZE);
  chunks.push({
    chunkIndex: 1,
    content: `${article.title}\n\n${wordsToText(introWords)}`,
    isIntro: true,
    isSummary: false
  });

  let chunkIndex = 2;
  let position = CHUNK_SIZE;

  while (position < words.length) {
    const start = Math.max(0, position - OVERLAP_SIZE);
    const end = Math.min(words.length, position + CHUNK_SIZE - OVERLAP_SIZE);
    const chunkWords = words.slice(start, end);

    if (chunkWords.length >= MIN_CHUNK_SIZE) {
      chunks.push({
        chunkIndex,
        content: wordsToText(chunkWords),
        isIntro: false,
        isSummary: false
      });
      chunkIndex++;
    }

    position = end;
  }

  return chunks;
}
