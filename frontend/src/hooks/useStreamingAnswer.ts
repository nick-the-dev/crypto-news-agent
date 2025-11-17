import { useState, useCallback } from 'react';
import { StructuredAnswer, ArticleSource, SSEEvent, SSEEventType } from '../types';

interface StreamingState {
  isStreaming: boolean;
  status: string;
  streamingTldr: string;
  streamingDetails: string;
  sources: ArticleSource[];
  answer: StructuredAnswer | null;
  error: string | null;
  currentQuestion: string;
}

export function useStreamingAnswer() {
  const [state, setState] = useState<StreamingState>({
    isStreaming: false,
    status: '',
    streamingTldr: '',
    streamingDetails: '',
    sources: [],
    answer: null,
    error: null,
    currentQuestion: ''
  });

  const askQuestion = useCallback(async (question: string) => {
    setState({
      isStreaming: true,
      status: 'Preparing...',
      streamingTldr: '',
      streamingDetails: '',
      sources: [],
      answer: null,
      error: null,
      currentQuestion: question
    });

    try {
      // Use relative URL in production (served from same origin), absolute URL in dev
      const apiUrl = import.meta.env.VITE_API_URL ||
        (import.meta.env.MODE === 'production' ? '' : 'http://localhost:3001');
      const response = await fetch(`${apiUrl}/ask`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question })
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Request failed');
      }

      const reader = response.body?.getReader();
      if (!reader) throw new Error('No response body');

      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.trim()) continue;

          const [eventLine, dataLine] = line.split('\n');
          if (!eventLine?.startsWith('event:') || !dataLine?.startsWith('data:')) continue;

          const eventType = eventLine.substring(6).trim() as SSEEventType;
          const eventData = JSON.parse(dataLine.substring(5).trim());

          handleSSEEvent({ type: eventType, data: eventData });
        }
      }
    } catch (error) {
      setState(prev => ({
        ...prev,
        isStreaming: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      }));
    }
  }, []);

  const handleSSEEvent = (event: SSEEvent) => {
    setState(prev => {
      switch (event.type) {
        case 'metadata':
          return { ...prev, status: 'Analyzing articles...' };

        case 'sources':
          return {
            ...prev,
            sources: event.data,
            // Create initial answer object so component can render and show streaming
            answer: {
              tldr: '',
              details: { content: '', citations: [] },
              confidence: 0,
              sources: event.data
            }
          };

        case 'status':
          return { ...prev, status: event.data.message };

        case 'tldr':
          return { ...prev, streamingTldr: event.data.content };

        case 'details':
          return { ...prev, streamingDetails: event.data.content };

        case 'structured':
          return {
            ...prev,
            answer: { ...event.data, sources: prev.sources }
          };

        case 'done':
          return { ...prev, isStreaming: false, status: 'Complete' };

        case 'error':
          return {
            ...prev,
            isStreaming: false,
            error: event.data.error
          };

        default:
          return prev;
      }
    });
  };

  return { ...state, askQuestion };
}
