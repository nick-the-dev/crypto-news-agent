import { useNavigate, useParams } from 'react-router-dom';
import { useChat } from '../context/ChatContext';
import { useSidebar } from '../App';
import { ChatListItem } from '../types';

function formatTimeAgo(dateString: string): string {
  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString();
}

interface ChatItemProps {
  chat: ChatListItem;
  isActive: boolean;
  onSelect: () => void;
  onDelete: () => void;
}

function ChatItem({ chat, isActive, onSelect, onDelete }: ChatItemProps) {
  return (
    <div
      onClick={onSelect}
      className={`
        group relative p-3 rounded-lg cursor-pointer transition-all duration-200
        ${isActive
          ? 'bg-indigo-100 border-l-4 border-indigo-600'
          : 'hover:bg-gray-100 border-l-4 border-transparent'
        }
      `}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <h3 className={`font-medium truncate ${isActive ? 'text-indigo-900' : 'text-gray-900'}`}>
            {chat.title}
          </h3>
          <p className="text-sm text-gray-500 truncate mt-1">
            {chat.lastMessage || 'No messages yet'}
          </p>
        </div>
        <button
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-red-100 text-gray-400 hover:text-red-600 transition-all"
          title="Delete chat"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
          </svg>
        </button>
      </div>
      <p className="text-xs text-gray-400 mt-2">
        {formatTimeAgo(chat.updatedAt)}
      </p>
    </div>
  );
}

export function ChatSidebar() {
  const navigate = useNavigate();
  const { threadId } = useParams<{ threadId: string }>();
  const { chats, startNewChat, deleteChat } = useChat();
  const { isOpen, setIsOpen } = useSidebar();

  const handleNewChat = () => {
    startNewChat();
    navigate('/chat');
    setIsOpen(false);
  };

  const handleSelectChat = (chatThreadId: string) => {
    navigate(`/chat/${chatThreadId}`);
    setIsOpen(false);
  };

  const handleDeleteChat = (chatThreadId: string) => {
    deleteChat(chatThreadId);
    if (chatThreadId === threadId) {
      navigate('/');
    }
  };

  return (
    <aside
      className={`
        fixed md:relative inset-y-0 left-0 z-50
        w-72 bg-white border-r border-gray-200 flex flex-col h-full
        transform transition-transform duration-300 ease-in-out
        ${isOpen ? 'translate-x-0' : '-translate-x-full'}
        md:translate-x-0
      `}
    >
      {/* Header */}
      <div className="p-4 border-b border-gray-200 flex items-center gap-2">
        {/* Close button for mobile */}
        <button
          onClick={() => setIsOpen(false)}
          className="md:hidden p-2 -ml-2 text-gray-500 hover:text-gray-700"
          aria-label="Close sidebar"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
        <button
          onClick={handleNewChat}
          className="flex-1 flex items-center justify-center gap-2 px-4 py-3 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg font-medium transition-colors"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
          New Chat
        </button>
      </div>

      {/* Chat List */}
      <div className="flex-1 overflow-y-auto p-2">
        {chats.length === 0 ? (
          <div className="text-center py-8 text-gray-500">
            <svg className="w-12 h-12 mx-auto mb-3 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
            </svg>
            <p className="text-sm">No chats yet</p>
            <p className="text-xs mt-1">Start a new conversation!</p>
          </div>
        ) : (
          <div className="space-y-1">
            {chats.map(chat => (
              <ChatItem
                key={chat.threadId}
                chat={chat}
                isActive={chat.threadId === threadId}
                onSelect={() => handleSelectChat(chat.threadId)}
                onDelete={() => handleDeleteChat(chat.threadId)}
              />
            ))}
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="p-4 border-t border-gray-200 text-center text-xs text-gray-400">
        <p>Crypto News Agent</p>
        <p className="mt-1">Powered by AI</p>
      </div>
    </aside>
  );
}
