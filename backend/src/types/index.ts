export interface RSSSource {
  name: string;
  url: string;
  contentField: 'content:encoded' | 'description';
  fallbackField?: string;
}

export interface RawArticle {
  url: string;
  title: string;
  content: string;
  publishedAt: Date;
  source: string;
  author: string | null;
}

export interface ArticleChunkData {
  chunkIndex: number;
  content: string;
  isIntro: boolean;
  isSummary: boolean;
}

export interface IngestionStats {
  fetched: number;
  existing: number;
  new: number;
  processed: number;
  errors: string[];
}

export interface SearchResult {
  article: {
    id: string;
    title: string;
    summary: string | null;
    source: string;
    url: string;
    publishedAt: Date;
  };
  chunk: {
    content: string;
    chunkIndex: number;
    isIntro: boolean;
    isSummary: boolean;
  };
  relevance: number;
  recencyHours: number;
}

export interface RawSearchResult {
  chunkId: string;
  chunkContent: string;
  chunkIndex: number;
  isIntro: boolean;
  isSummary: boolean;
  similarity: number;
  articleId: string;
  title: string;
  summary: string | null;
  source: string;
  url: string;
  publishedAt: Date;
}
