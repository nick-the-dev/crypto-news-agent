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
    threadId?: string;
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: Record<string, unknown>;
}

// Chat-related types
export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
  answer?: StructuredAnswer;
}

export interface Chat {
  id: string;
  threadId: string;
  title: string;
  messages: ChatMessage[];
  createdAt: string;
  updatedAt: string;
}

export interface ChatListItem {
  id: string;
  threadId: string;
  title: string;
  lastMessage: string;
  updatedAt: string;
}
