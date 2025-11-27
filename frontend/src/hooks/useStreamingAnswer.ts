import { useState, useCallback, useRef } from 'react';
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
  threadId: string | null;
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
    currentQuestion: '',
    threadId: null
  });

  // Store threadId in ref for callbacks
  const threadIdRef = useRef<string | null>(null);

  const askQuestion = useCallback(async (question: string, threadId?: string) => {
    // Use provided threadId or existing one
    const effectiveThreadId = threadId || threadIdRef.current;

    setState({
      isStreaming: true,
      status: 'Preparing...',
      streamingTldr: '',
      streamingDetails: '',
      sources: [],
      answer: null,
      error: null,
      currentQuestion: question,
      threadId: effectiveThreadId
    });

    try {
      // Use relative URL in production (served from same origin), absolute URL in dev
      const apiUrl = import.meta.env.VITE_API_URL ||
        (import.meta.env.MODE === 'production' ? '' : 'http://localhost:3001');
      const response = await fetch(`${apiUrl}/ask`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question, threadId: effectiveThreadId })
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
        case 'metadata': {
          // Extract threadId from metadata and store it
          const newThreadId = event.data.threadId as string | undefined;
          if (newThreadId) {
            threadIdRef.current = newThreadId;
          }
          return { ...prev, status: 'Analyzing articles...', threadId: newThreadId || prev.threadId };
        }

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

        case 'token':
          // Append token to streaming details for real-time streaming
          // Create placeholder answer if none exists so component renders
          const newAnswer = prev.answer || {
            tldr: '',
            details: { content: '', citations: [] },
            confidence: 0,
            sources: []
          };
          return {
            ...prev,
            streamingDetails: prev.streamingDetails + event.data.token,
            answer: newAnswer
          };

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

  // Reset state for new conversation
  const reset = useCallback(() => {
    threadIdRef.current = null;
    setState({
      isStreaming: false,
      status: '',
      streamingTldr: '',
      streamingDetails: '',
      sources: [],
      answer: null,
      error: null,
      currentQuestion: '',
      threadId: null
    });
  }, []);

  // Set threadId for continuing a conversation
  const setThreadId = useCallback((threadId: string | null) => {
    threadIdRef.current = threadId;
    setState(prev => ({ ...prev, threadId }));
  }, []);

  return { ...state, askQuestion, reset, setThreadId };
}
