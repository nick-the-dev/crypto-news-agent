import { Request, Response } from 'express';
import { prisma } from '../utils/db';

export async function healthCheck(_req: Request, res: Response): Promise<void> {
  try {
    await prisma.$queryRaw`SELECT 1`;

    const totalArticles = await prisma.article.count();
    const latest = await prisma.article.findFirst({
      orderBy: { publishedAt: 'desc' },
      select: { publishedAt: true }
    });

    res.json({
      status: 'healthy',
      database: 'connected',
      totalArticles,
      latestArticle: latest?.publishedAt?.toISOString() || null,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(503).json({
      status: 'unhealthy',
      database: 'disconnected',
      timestamp: new Date().toISOString()
    });
  }
}
