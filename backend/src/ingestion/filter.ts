import { RawArticle } from '../types';
import { prisma } from '../utils/db';

export async function filterNewArticles(articles: RawArticle[]): Promise<RawArticle[]> {
  if (articles.length === 0) {
    return [];
  }

  const urls = articles.map(a => a.url);

  const existingArticles = await prisma.article.findMany({
    where: {
      url: {
        in: urls
      }
    },
    select: {
      url: true
    }
  });

  const existingUrls = new Set(existingArticles.map((a: { url: string }) => a.url));
  const newArticles = articles.filter((a: RawArticle) => !existingUrls.has(a.url));

  return newArticles;
}
