import { useEffect, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useChat } from '@/context/ChatContext';
import { useStreamingAnswer } from '@/hooks/useStreamingAnswer';
import { QuestionInput } from '@/components/QuestionInput';
import { LoadingIndicator } from '@/components/LoadingIndicator';
import { StructuredAnswer } from '@/components/StructuredAnswer';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { SidebarTrigger } from '@/components/ui/sidebar';
import { Separator } from '@/components/ui/separator';
import { ChatMessage } from '@/types';
import { TrendingUp, Building2, Scale, Sparkles } from 'lucide-react';

function MessageBubble({ message }: { message: ChatMessage }) {
  const isUser = message.role === 'user';

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'} mb-4`}>
      <div
        className={`${isUser ? 'max-w-[90%] sm:max-w-[85%]' : 'max-w-[95%] sm:max-w-[85%]'} ${
          isUser
            ? 'bg-primary text-primary-foreground rounded-2xl rounded-br-md px-3 sm:px-4 py-2 sm:py-3'
            : 'bg-card rounded-2xl rounded-bl-md shadow-sm'
        }`}
      >
        {isUser ? (
          <p className="whitespace-pre-wrap text-sm sm:text-base">{message.content}</p>
        ) : message.answer ? (
          <StructuredAnswer answer={message.answer} />
        ) : (
          <p className="px-3 sm:px-4 py-2 sm:py-3 text-muted-foreground whitespace-pre-wrap text-sm sm:text-base">{message.content}</p>
        )}
      </div>
    </div>
  );
}

export function ChatPage() {
  const { threadId } = useParams<{ threadId: string }>();
  const navigate = useNavigate();
  const { currentChat, loadChat, registerThread, addMessage, updateLastMessage } = useChat();
  const { isStreaming, status, streamingTldr, streamingDetails, answer, error, threadId: backendThreadId, askQuestion, setThreadId } = useStreamingAnswer();
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const initializedRef = useRef<string | null>(null);
  const userScrolledUpRef = useRef(false);
  const prevMessageCountRef = useRef(0);
  const pendingQuestionRef = useRef<string | null>(null);
  const lastUpdatedAnswerRef = useRef<string | null>(null);

  // Refs to avoid dependency cycles in effects
  const currentChatRef = useRef(currentChat);
  const updateLastMessageRef = useRef(updateLastMessage);

  // Keep refs in sync
  useEffect(() => {
    currentChatRef.current = currentChat;
  }, [currentChat]);

  useEffect(() => {
    updateLastMessageRef.current = updateLastMessage;
  }, [updateLastMessage]);

  // Load chat when threadId changes
  useEffect(() => {
    if (threadId && threadId !== initializedRef.current) {
      initializedRef.current = threadId;
      loadChat(threadId);
      setThreadId(threadId);
      userScrolledUpRef.current = false;
      prevMessageCountRef.current = 0;
    }
  }, [threadId, loadChat, setThreadId]);

  // Handle URL update when backend returns a new threadId
  useEffect(() => {
    if (backendThreadId && !threadId && pendingQuestionRef.current) {
      // Backend created a new thread - update URL and register it
      navigate(`/chat/${backendThreadId}`, { replace: true });
      registerThread(backendThreadId, pendingQuestionRef.current);

      // Add the pending messages to the new thread
      addMessage({ role: 'user', content: pendingQuestionRef.current }, backendThreadId);
      addMessage({ role: 'assistant', content: '' }, backendThreadId);

      pendingQuestionRef.current = null;
    }
  }, [backendThreadId, threadId, navigate, registerThread, addMessage]);

  // Track if user has scrolled up
  const handleScroll = () => {
    const container = messagesContainerRef.current;
    if (!container) return;

    const { scrollTop, scrollHeight, clientHeight } = container;
    const isNearBottom = scrollHeight - scrollTop - clientHeight < 100;
    userScrolledUpRef.current = !isNearBottom;
  };

  // Scroll to bottom only when NEW messages are added (not on initial load)
  useEffect(() => {
    const currentCount = currentChat?.messages.length || 0;
    const isNewMessage = currentCount > prevMessageCountRef.current && prevMessageCountRef.current > 0;

    if (isNewMessage && !userScrolledUpRef.current) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }

    prevMessageCountRef.current = currentCount;
  }, [currentChat?.messages]);

  // Auto-scroll during streaming only if user hasn't scrolled up
  useEffect(() => {
    if (isStreaming && !userScrolledUpRef.current) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [isStreaming, streamingDetails]);

  // Update chat context when streaming completes
  useEffect(() => {
    // Create a unique key for this answer to prevent duplicate updates
    const answerKey = answer ? `${answer.details.content.substring(0, 50)}-${answer.confidence}` : null;

    // Use refs to avoid dependency cycle (updateLastMessage updates currentChat)
    if (!isStreaming && answer && currentChatRef.current && answerKey !== lastUpdatedAnswerRef.current) {
      // Update the last assistant message with the final answer
      lastUpdatedAnswerRef.current = answerKey;
      updateLastMessageRef.current({ answer, content: answer.details.content });
    }
  }, [isStreaming, answer]); // Removed currentChat and updateLastMessage - accessed via refs

  const handleSubmit = async (question: string) => {
    // Reset the answer tracking ref for new question
    lastUpdatedAnswerRef.current = null;

    if (threadId) {
      // Existing thread - add messages and send
      addMessage({ role: 'user', content: question }, threadId);
      addMessage({ role: 'assistant', content: '' }, threadId);
      await askQuestion(question, threadId);
    } else {
      // New chat - send without threadId, backend will create one
      // Store the question to add to chat after we get threadId
      pendingQuestionRef.current = question;
      await askQuestion(question);
    }
  };

  // Show welcome screen if no chat selected and not waiting for a response
  if (!threadId && !pendingQuestionRef.current && !isStreaming) {
    return (
      <div className="flex-1 flex flex-col bg-background">
        <div className="flex-1 flex flex-col items-center justify-center p-4 sm:p-8">
          <div className="text-center max-w-2xl w-full">
            <div className="flex items-center justify-center gap-2 mb-4">
              <Sparkles className="h-10 w-10 text-primary" />
            </div>
            <h1 className="text-3xl sm:text-4xl md:text-5xl font-bold text-foreground mb-2 sm:mb-4">
              Crypto News Agent
            </h1>
            <p className="text-base sm:text-lg md:text-xl text-muted-foreground mb-6 sm:mb-8">
              AI-powered answers from the latest crypto news
            </p>
            <Card className="mb-6 sm:mb-8">
              <CardContent className="p-4 sm:p-6">
                <QuestionInput onSubmit={handleSubmit} disabled={isStreaming} />
              </CardContent>
            </Card>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 sm:gap-4">
              <Button
                variant="outline"
                onClick={() => handleSubmit("What's happening with Bitcoin today?")}
                className="group h-auto p-4 flex items-center gap-3 justify-start"
              >
                <TrendingUp className="h-5 w-5 text-primary group-hover:text-primary-foreground shrink-0" />
                <span className="font-medium text-foreground group-hover:text-primary-foreground text-sm">Bitcoin Today</span>
              </Button>
              <Button
                variant="outline"
                onClick={() => handleSubmit("What are the latest DeFi developments?")}
                className="group h-auto p-4 flex items-center gap-3 justify-start"
              >
                <Building2 className="h-5 w-5 text-primary group-hover:text-primary-foreground shrink-0" />
                <span className="font-medium text-foreground group-hover:text-primary-foreground text-sm">DeFi Updates</span>
              </Button>
              <Button
                variant="outline"
                onClick={() => handleSubmit("Any major crypto regulations news?")}
                className="group h-auto p-4 flex items-center gap-3 justify-start"
              >
                <Scale className="h-5 w-5 text-primary group-hover:text-primary-foreground shrink-0" />
                <span className="font-medium text-foreground group-hover:text-primary-foreground text-sm">Regulation News</span>
              </Button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Show loading/streaming state for new chats before URL updates
  if (!threadId && (pendingQuestionRef.current || isStreaming)) {
    return (
      <div className="flex-1 flex flex-col h-full bg-background">
        <header className="bg-card border-b border-border px-4 sm:px-6 py-3 sm:py-4 flex items-center gap-2">
          <SidebarTrigger className="md:hidden -ml-1" />
          <Separator orientation="vertical" className="mr-2 h-4 md:hidden" />
          <h2 className="font-semibold text-foreground">New Chat</h2>
        </header>

        <div className="flex-1 overflow-y-auto p-3 sm:p-6">
          <div className="max-w-4xl mx-auto">
            {/* User message */}
            <div className="flex justify-end mb-4">
              <div className="max-w-[90%] sm:max-w-[85%] bg-primary text-primary-foreground rounded-2xl rounded-br-md px-3 sm:px-4 py-2 sm:py-3">
                <p className="whitespace-pre-wrap text-sm sm:text-base">{pendingQuestionRef.current}</p>
              </div>
            </div>

            {/* Assistant response */}
            <div className="flex justify-start mb-4">
              <div className="max-w-[95%] sm:max-w-[85%] bg-card rounded-2xl rounded-bl-md shadow-sm">
                {answer ? (
                  <StructuredAnswer
                    answer={answer}
                    streamingTldr={streamingTldr}
                    streamingDetails={streamingDetails}
                  />
                ) : (
                  <div className="p-3 sm:p-4">
                    <LoadingIndicator status={status} />
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>

        <div className="bg-card border-t border-border p-3 sm:p-4">
          <div className="max-w-4xl mx-auto">
            <QuestionInput onSubmit={handleSubmit} disabled={isStreaming} />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col h-full bg-background">
      {/* Chat Header */}
      <header className="bg-card border-b border-border px-4 sm:px-6 py-3 sm:py-4 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <SidebarTrigger className="md:hidden -ml-1" />
          <Separator orientation="vertical" className="mr-2 h-4 md:hidden" />
          <div className="min-w-0">
            <h2 className="font-semibold text-foreground truncate">
              {currentChat?.title || 'New Chat'}
            </h2>
            <p className="text-xs sm:text-sm text-muted-foreground">
              {currentChat?.messages.length || 0} messages
            </p>
          </div>
        </div>
      </header>

      {/* Messages Area */}
      <div
        ref={messagesContainerRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto p-3 sm:p-6"
      >
        <div className="max-w-4xl mx-auto">
          {currentChat?.messages.map((message, index) => {
            // For the last assistant message during streaming, show streaming content
            const isLastAssistant =
              message.role === 'assistant' &&
              index === currentChat.messages.length - 1 &&
              isStreaming;

            if (isLastAssistant) {
              return (
                <div key={message.id} className="flex justify-start mb-4">
                  <div className="max-w-[95%] sm:max-w-[85%] bg-card rounded-2xl rounded-bl-md shadow-sm">
                    {answer ? (
                      <StructuredAnswer
                        answer={answer}
                        streamingTldr={streamingTldr}
                        streamingDetails={streamingDetails}
                      />
                    ) : (
                      <div className="p-3 sm:p-4">
                        <LoadingIndicator status={status} />
                      </div>
                    )}
                  </div>
                </div>
              );
            }

            // Skip empty assistant messages
            if (message.role === 'assistant' && !message.content && !message.answer) {
              return null;
            }

            return <MessageBubble key={message.id} message={message} />;
          })}

          {error && (
            <Card className="mb-4 border-destructive bg-destructive/10">
              <CardContent className="p-3 sm:p-4">
                <div className="flex items-center gap-2">
                  <span className="text-xl sm:text-2xl">⚠️</span>
                  <p className="text-destructive text-sm sm:text-base">Error: {error}</p>
                </div>
              </CardContent>
            </Card>
          )}

          <div ref={messagesEndRef} />
        </div>
      </div>

      {/* Input Area */}
      <div className="bg-card border-t border-border p-3 sm:p-4">
        <div className="max-w-4xl mx-auto">
          <QuestionInput onSubmit={handleSubmit} disabled={isStreaming} />
        </div>
      </div>
    </div>
  );
}
