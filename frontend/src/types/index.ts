export interface StructuredAnswer {
  tldr: string;
  details: {
    content: string;
    citations: number[];
  };
  confidence: number;
  metadata?: {
    queryTimestamp: string;
    newsTimestamp?: string;
    articlesAnalyzed: number;
    processingTime?: number;
  };
  sources: ArticleSource[];
}

export interface ArticleSource {
  number: number;
  title: string;
  source: string;
  url: string;
  publishedAt: string;
  relevance: number;
}

export type SSEEventType = 'metadata' | 'sources' | 'status' | 'tldr' | 'details' | 'token' | 'structured' | 'done' | 'error';

export interface SSEEvent {
  type: SSEEventType;
  data: any;
}
