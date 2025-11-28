import { useNavigate, useParams } from 'react-router-dom';
import { useChat } from '@/context/ChatContext';
import { ChatListItem } from '@/types';
import { ThemeToggle } from '@/components/theme-toggle';
import { Button } from '@/components/ui/button';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuAction,
  useSidebar,
} from '@/components/ui/sidebar';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { Plus, MessageSquare, Trash2, Sparkles } from 'lucide-react';

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
  const { state } = useSidebar();
  const isCollapsed = state === 'collapsed';

  return (
    <SidebarMenuItem className="overflow-hidden">
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <SidebarMenuButton
              onClick={onSelect}
              isActive={isActive}
              className="w-full max-w-full"
            >
              <MessageSquare className="h-4 w-4 shrink-0" />
              {!isCollapsed && (
                <span className="truncate">{chat.title}</span>
              )}
            </SidebarMenuButton>
          </TooltipTrigger>
          {isCollapsed && (
            <TooltipContent side="right">
              <p>{chat.title}</p>
              <p className="text-xs text-muted-foreground">{formatTimeAgo(chat.updatedAt)}</p>
            </TooltipContent>
          )}
        </Tooltip>
      </TooltipProvider>
      {!isCollapsed && (
        <SidebarMenuAction
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          className="opacity-0 group-hover/menu-item:opacity-100"
        >
          <Trash2 className="h-4 w-4 text-muted-foreground hover:text-destructive" />
        </SidebarMenuAction>
      )}
    </SidebarMenuItem>
  );
}

export function AppSidebar() {
  const navigate = useNavigate();
  const { threadId } = useParams<{ threadId: string }>();
  const { chats, startNewChat, deleteChat } = useChat();
  const { setOpenMobile, state } = useSidebar();
  const isCollapsed = state === 'collapsed';

  const handleNewChat = () => {
    startNewChat();
    navigate('/chat');
    setOpenMobile(false);
  };

  const handleSelectChat = (chatThreadId: string) => {
    navigate(`/chat/${chatThreadId}`);
    setOpenMobile(false);
  };

  const handleDeleteChat = (chatThreadId: string) => {
    deleteChat(chatThreadId);
    if (chatThreadId === threadId) {
      navigate('/');
    }
  };

  return (
    <Sidebar collapsible="icon" className="border-r">
      <SidebarHeader className="border-b border-sidebar-border">
        <button
          onClick={handleNewChat}
          className="flex items-center gap-2 px-2 py-2 hover:opacity-80 transition-opacity"
        >
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <Sparkles className="h-4 w-4" />
          </div>
          {!isCollapsed && (
            <div className="flex flex-col text-left">
              <span className="text-sm font-semibold">Crypto News</span>
              <span className="text-xs text-muted-foreground">AI Agent</span>
            </div>
          )}
        </button>
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                onClick={handleNewChat}
                variant="default"
                size={isCollapsed ? "icon" : "default"}
                className="w-full"
              >
                <Plus className="h-4 w-4" />
                {!isCollapsed && <span className="ml-2">New Chat</span>}
              </Button>
            </TooltipTrigger>
            {isCollapsed && (
              <TooltipContent side="right">
                New Chat
              </TooltipContent>
            )}
          </Tooltip>
        </TooltipProvider>
      </SidebarHeader>

      <SidebarContent>
          <SidebarGroup className="pr-3">
            {!isCollapsed && (
              <SidebarGroupLabel>Recent Chats</SidebarGroupLabel>
            )}
            <SidebarGroupContent>
              <SidebarMenu>
                {chats.length === 0 ? (
                  !isCollapsed && (
                    <div className="px-3 py-8 text-center text-muted-foreground">
                      <MessageSquare className="mx-auto mb-3 h-12 w-12 opacity-30" />
                      <p className="text-sm">No chats yet</p>
                      <p className="text-xs mt-1">Start a new conversation!</p>
                    </div>
                  )
                ) : (
                  chats.map(chat => (
                    <ChatItem
                      key={chat.threadId}
                      chat={chat}
                      isActive={chat.threadId === threadId}
                      onSelect={() => handleSelectChat(chat.threadId)}
                      onDelete={() => handleDeleteChat(chat.threadId)}
                    />
                  ))
                )}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
      </SidebarContent>

      <SidebarFooter className="border-t border-sidebar-border">
        <div className="flex items-center justify-between px-2 py-2">
          {!isCollapsed && (
            <span className="text-xs text-muted-foreground">
              Powered by AI
            </span>
          )}
          <ThemeToggle />
        </div>
      </SidebarFooter>
    </Sidebar>
  );
}
