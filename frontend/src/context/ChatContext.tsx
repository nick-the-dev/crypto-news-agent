import { createContext, useContext, useState, useEffect, useCallback, useRef, ReactNode } from 'react';
import { Chat, ChatMessage, ChatListItem, ArticleSource } from '@/types';

interface ChatContextType {
  chats: ChatListItem[];
  currentChat: Chat | null;
  isLoading: boolean;
  startNewChat: () => void;
  loadChat: (threadId: string) => Promise<void>;
  registerThread: (threadId: string, firstMessage: string) => void;
  addMessage: (message: Omit<ChatMessage, 'id' | 'timestamp'>, threadId?: string) => void;
  updateLastMessage: (updates: Partial<ChatMessage>) => void;
  deleteChat: (threadId: string) => Promise<void>;
  getCurrentThreadId: () => string | null;
  refreshChats: () => Promise<void>;
}

const ChatContext = createContext<ChatContextType | null>(null);

const STORAGE_KEY = 'crypto-news-chats';

// Generate a unique ID
function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

// Generate chat title from first message
function generateTitle(message: string): string {
  const cleaned = message.trim().substring(0, 50);
  return cleaned.length < message.trim().length ? `${cleaned}...` : cleaned;
}

// Load chats from localStorage (fallback/cache)
function loadChatsFromStorage(): Map<string, Chat> {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored);
      return new Map(Object.entries(parsed));
    }
  } catch (e) {
    console.error('Failed to load chats from storage:', e);
  }
  return new Map();
}

// Save chats to localStorage
function saveChatsToStorage(chats: Map<string, Chat>): void {
  try {
    const obj = Object.fromEntries(chats);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(obj));
  } catch (e) {
    console.error('Failed to save chats to storage:', e);
  }
}

// API base URL
function getApiUrl(): string {
  return import.meta.env.VITE_API_URL ||
    (import.meta.env.MODE === 'production' ? '' : 'http://localhost:3001');
}

export function ChatProvider({ children }: { children: ReactNode }) {
  const [chatsMap, setChatsMap] = useState<Map<string, Chat>>(() => loadChatsFromStorage());
  const [currentThreadId, setCurrentThreadId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [apiChatList, setApiChatList] = useState<ChatListItem[]>([]);

  // Use ref to access chatsMap without adding it as a dependency
  const chatsMapRef = useRef(chatsMap);
  useEffect(() => {
    chatsMapRef.current = chatsMap;
  }, [chatsMap]);

  // Get sorted chat list - merge API list with local chats
  const chats: ChatListItem[] = (() => {
    // Start with API list
    const merged = new Map<string, ChatListItem>();

    // Add API chats
    apiChatList.forEach(chat => {
      merged.set(chat.threadId, chat);
    });

    // Add/override with local chats (they're more up-to-date)
    Array.from(chatsMap.values()).forEach(chat => {
      merged.set(chat.threadId, {
        id: chat.id,
        threadId: chat.threadId,
        title: chat.title,
        lastMessage: chat.messages[chat.messages.length - 1]?.content || '',
        updatedAt: chat.updatedAt,
      });
    });

    return Array.from(merged.values())
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  })();

  // Get current chat
  const currentChat = currentThreadId ? chatsMap.get(currentThreadId) || null : null;

  // Save to storage whenever chats change
  useEffect(() => {
    saveChatsToStorage(chatsMap);
  }, [chatsMap]);

  // Load chat list from API on mount
  useEffect(() => {
    refreshChats();
  }, []);

  // Fetch chat list from API
  const refreshChats = useCallback(async () => {
    try {
      const response = await fetch(`${getApiUrl()}/api/conversations`);
      if (response.ok) {
        const data = await response.json();
        setApiChatList(data.conversations.map((c: { threadId: string; title: string; lastMessage: string; createdAt: string; updatedAt: string }) => ({
          id: c.threadId,
          threadId: c.threadId,
          title: c.title,
          lastMessage: c.lastMessage,
          updatedAt: c.updatedAt,
        })));
      }
    } catch (e) {
      console.error('Failed to fetch conversations from API:', e);
    }
  }, []);

  // Start a new chat (lazy - don't create threadId yet)
  const startNewChat = useCallback(() => {
    setCurrentThreadId(null);
  }, []);

  // Register a thread after backend creates it (on first message)
  const registerThread = useCallback((threadId: string, firstMessage: string) => {
    const newChat: Chat = {
      id: generateId(),
      threadId,
      title: generateTitle(firstMessage),
      messages: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    setChatsMap(prev => {
      const updated = new Map(prev);
      updated.set(threadId, newChat);
      return updated;
    });

    setCurrentThreadId(threadId);
  }, []);

  // Load an existing chat
  const loadChat = useCallback(async (threadId: string) => {
    // Check if already in memory (use ref to avoid dependency)
    const existingChat = chatsMapRef.current.get(threadId);
    if (existingChat && existingChat.messages.length > 0) {
      setCurrentThreadId(threadId);
      return;
    }

    // Fetch from API
    setIsLoading(true);
    try {
      const response = await fetch(`${getApiUrl()}/api/conversations/${threadId}`);
      if (response.ok) {
        const data = await response.json();

        // Convert API response to Chat format
        const messages: ChatMessage[] = data.turns.map((turn: { role: string; content: string; sources?: ArticleSource[]; createdAt: string }, index: number) => ({
          id: `${threadId}-${index}`,
          role: turn.role,
          content: turn.content,
          timestamp: turn.createdAt,
          // Reconstruct answer for assistant messages with sources
          answer: turn.role === 'assistant' && turn.sources ? {
            tldr: turn.content.split('.')[0] + '.',
            details: { content: turn.content, citations: [] },
            confidence: 80,
            sources: turn.sources,
          } : undefined,
        }));

        const chat: Chat = {
          id: threadId,
          threadId,
          title: messages.length > 0 ? generateTitle(messages[0].content) : 'Chat',
          messages,
          createdAt: messages[0]?.timestamp || new Date().toISOString(),
          updatedAt: messages[messages.length - 1]?.timestamp || new Date().toISOString(),
        };

        setChatsMap(prev => {
          const updated = new Map(prev);
          updated.set(threadId, chat);
          return updated;
        });
      }
    } catch (e) {
      console.error('Failed to load chat from API:', e);
    } finally {
      setIsLoading(false);
      setCurrentThreadId(threadId);
    }
  }, []); // No dependencies needed - uses ref

  // Add a message to current chat
  const addMessage = useCallback((message: Omit<ChatMessage, 'id' | 'timestamp'>, threadId?: string) => {
    const targetThreadId = threadId || currentThreadId;
    if (!targetThreadId) return;

    const newMessage: ChatMessage = {
      ...message,
      id: generateId(),
      timestamp: new Date().toISOString(),
    };

    setChatsMap(prev => {
      const updated = new Map(prev);
      let chat = updated.get(targetThreadId);

      // Create chat if doesn't exist (happens when registerThread was just called)
      if (!chat) {
        chat = {
          id: generateId(),
          threadId: targetThreadId,
          title: message.role === 'user' ? generateTitle(message.content) : 'New Chat',
          messages: [],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
      }

      const updatedChat = {
        ...chat,
        messages: [...chat.messages, newMessage],
        updatedAt: new Date().toISOString(),
        // Update title from first user message
        title: chat.messages.length === 0 && message.role === 'user'
          ? generateTitle(message.content)
          : chat.title,
      };
      updated.set(targetThreadId, updatedChat);
      return updated;
    });
  }, [currentThreadId]);

  // Update the last message (for streaming updates)
  const updateLastMessage = useCallback((updates: Partial<ChatMessage>) => {
    if (!currentThreadId) return;

    setChatsMap(prev => {
      const updated = new Map(prev);
      const chat = updated.get(currentThreadId);
      if (chat && chat.messages.length > 0) {
        const messages = [...chat.messages];
        const lastIndex = messages.length - 1;
        messages[lastIndex] = { ...messages[lastIndex], ...updates };
        updated.set(currentThreadId, {
          ...chat,
          messages,
          updatedAt: new Date().toISOString(),
        });
      }
      return updated;
    });
  }, [currentThreadId]);

  // Delete a chat
  const deleteChat = useCallback(async (threadId: string) => {
    // Delete from API
    try {
      await fetch(`${getApiUrl()}/api/conversations/${threadId}`, { method: 'DELETE' });
    } catch (e) {
      console.error('Failed to delete chat from API:', e);
    }

    // Delete from local state
    setChatsMap(prev => {
      const updated = new Map(prev);
      updated.delete(threadId);
      return updated;
    });

    // Remove from API list
    setApiChatList(prev => prev.filter(c => c.threadId !== threadId));

    if (currentThreadId === threadId) {
      setCurrentThreadId(null);
    }
  }, [currentThreadId]);

  // Get current thread ID
  const getCurrentThreadId = useCallback(() => currentThreadId, [currentThreadId]);

  return (
    <ChatContext.Provider
      value={{
        chats,
        currentChat,
        isLoading,
        startNewChat,
        loadChat,
        registerThread,
        addMessage,
        updateLastMessage,
        deleteChat,
        getCurrentThreadId,
        refreshChats,
      }}
    >
      {children}
    </ChatContext.Provider>
  );
}

export function useChat() {
  const context = useContext(ChatContext);
  if (!context) {
    throw new Error('useChat must be used within a ChatProvider');
  }
  return context;
}
