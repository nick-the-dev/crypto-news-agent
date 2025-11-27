import { createContext, useContext, useState, useEffect, useCallback, ReactNode } from 'react';
import { Chat, ChatMessage, ChatListItem, StructuredAnswer } from '../types';

interface ChatContextType {
  chats: ChatListItem[];
  currentChat: Chat | null;
  isLoading: boolean;
  createNewChat: () => string;
  loadChat: (threadId: string) => void;
  addMessage: (message: Omit<ChatMessage, 'id' | 'timestamp'>, threadId?: string) => void;
  updateLastMessage: (updates: Partial<ChatMessage>) => void;
  deleteChat: (threadId: string) => void;
  getCurrentThreadId: () => string | null;
}

const ChatContext = createContext<ChatContextType | null>(null);

const STORAGE_KEY = 'crypto-news-chats';

// Generate a unique ID
function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

// Generate thread ID (matching backend format)
function generateThreadId(): string {
  return `thread-${Date.now()}`;
}

// Generate chat title from first message
function generateTitle(message: string): string {
  const cleaned = message.trim().substring(0, 50);
  return cleaned.length < message.trim().length ? `${cleaned}...` : cleaned;
}

// Load chats from localStorage
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

export function ChatProvider({ children }: { children: ReactNode }) {
  const [chatsMap, setChatsMap] = useState<Map<string, Chat>>(() => loadChatsFromStorage());
  const [currentThreadId, setCurrentThreadId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  // Get sorted chat list for sidebar
  const chats: ChatListItem[] = Array.from(chatsMap.values())
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    .map(chat => ({
      id: chat.id,
      threadId: chat.threadId,
      title: chat.title,
      lastMessage: chat.messages[chat.messages.length - 1]?.content || '',
      updatedAt: chat.updatedAt,
    }));

  // Get current chat
  const currentChat = currentThreadId ? chatsMap.get(currentThreadId) || null : null;

  // Save to storage whenever chats change
  useEffect(() => {
    saveChatsToStorage(chatsMap);
  }, [chatsMap]);

  // Create a new chat
  const createNewChat = useCallback((): string => {
    const threadId = generateThreadId();
    const newChat: Chat = {
      id: generateId(),
      threadId,
      title: 'New Chat',
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
    return threadId;
  }, []);

  // Load an existing chat
  const loadChat = useCallback((threadId: string) => {
    setIsLoading(true);
    const chat = chatsMap.get(threadId);
    if (chat) {
      setCurrentThreadId(threadId);
    }
    setIsLoading(false);
  }, [chatsMap]);

  // Add a message to current chat (accepts optional threadId for immediate use after createNewChat)
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
      const chat = updated.get(targetThreadId);
      if (chat) {
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
      }
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
  const deleteChat = useCallback((threadId: string) => {
    setChatsMap(prev => {
      const updated = new Map(prev);
      updated.delete(threadId);
      return updated;
    });

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
        createNewChat,
        loadChat,
        addMessage,
        updateLastMessage,
        deleteChat,
        getCurrentThreadId,
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
