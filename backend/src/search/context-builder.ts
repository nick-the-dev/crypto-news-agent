import { SearchResult } from '../types';

export function reorderForAttention(results: SearchResult[]): SearchResult[] {
  if (results.length <= 2) return results;

  const reordered = [...results];
  const last = reordered.pop()!;

  return [reordered[0], ...reordered.slice(1), last];
}

export function buildContext(results: SearchResult[]): string {
  const reorderedResults = reorderForAttention(results);

  return reorderedResults.map((result, index) => {
    const number = index + 1;
    const hoursAgo = Math.round(result.recencyHours);
    const timeAgo = hoursAgo < 24
      ? `${hoursAgo} hours ago`
      : `${Math.round(hoursAgo / 24)} days ago`;

    const timestamp = result.article.publishedAt.toISOString();
    const maxContentLength = 800;
    const content = result.chunk.content.length > maxContentLength
      ? result.chunk.content.substring(0, maxContentLength) + '...'
      : result.chunk.content;

    return `[${number}] ${result.article.title}
Source: ${result.article.source} | Published: ${timestamp} (${timeAgo})
Relevance: ${result.relevance}%

${result.article.summary ? `Summary: ${result.article.summary}\n\n` : ''}Relevant Content:
${content}

Full article: ${result.article.url}

---`;
  }).join('\n\n');
}
