import { useEffect, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useChat } from '../context/ChatContext';
import { useStreamingAnswer } from '../hooks/useStreamingAnswer';
import { QuestionInput } from '../components/QuestionInput';
import { LoadingIndicator } from '../components/LoadingIndicator';
import { StructuredAnswer } from '../components/StructuredAnswer';
import { ChatMessage } from '../types';

function MessageBubble({ message }: { message: ChatMessage }) {
  const isUser = message.role === 'user';

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'} mb-4`}>
      <div
        className={`max-w-[85%] ${
          isUser
            ? 'bg-indigo-600 text-white rounded-2xl rounded-br-md px-4 py-3'
            : 'bg-white rounded-2xl rounded-bl-md shadow-sm'
        }`}
      >
        {isUser ? (
          <p className="whitespace-pre-wrap">{message.content}</p>
        ) : message.answer ? (
          <div className="p-2">
            <StructuredAnswer answer={message.answer} question="" />
          </div>
        ) : (
          <p className="px-4 py-3 text-gray-700 whitespace-pre-wrap">{message.content}</p>
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
      <div className="flex-1 flex flex-col items-center justify-center p-8 bg-gradient-to-br from-blue-50 to-indigo-100">
        <div className="text-center max-w-2xl">
          <h1 className="text-5xl font-bold text-gray-900 mb-4">
            Crypto News Agent
          </h1>
          <p className="text-xl text-gray-600 mb-8">
            AI-powered answers from the latest crypto news
          </p>
          <div className="bg-white rounded-2xl shadow-lg p-6 mb-8">
            <QuestionInput onSubmit={handleSubmit} disabled={isStreaming} />
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-left">
            <button
              onClick={() => handleSubmit("What's happening with Bitcoin today?")}
              className="p-4 bg-white rounded-xl shadow-sm hover:shadow-md transition-shadow text-left"
            >
              <span className="text-2xl mb-2 block">📈</span>
              <span className="font-medium text-gray-900">Bitcoin Today</span>
              <p className="text-sm text-gray-500 mt-1">Latest BTC news and price action</p>
            </button>
            <button
              onClick={() => handleSubmit("What are the latest DeFi developments?")}
              className="p-4 bg-white rounded-xl shadow-sm hover:shadow-md transition-shadow text-left"
            >
              <span className="text-2xl mb-2 block">🏦</span>
              <span className="font-medium text-gray-900">DeFi Updates</span>
              <p className="text-sm text-gray-500 mt-1">Decentralized finance news</p>
            </button>
            <button
              onClick={() => handleSubmit("Any major crypto regulations news?")}
              className="p-4 bg-white rounded-xl shadow-sm hover:shadow-md transition-shadow text-left"
            >
              <span className="text-2xl mb-2 block">⚖️</span>
              <span className="font-medium text-gray-900">Regulation News</span>
              <p className="text-sm text-gray-500 mt-1">Policy and regulatory updates</p>
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Show loading/streaming state for new chats before URL updates
  if (!threadId && (pendingQuestionRef.current || isStreaming)) {
    return (
      <div className="flex-1 flex flex-col h-full bg-gradient-to-br from-blue-50 to-indigo-100">
        <header className="bg-white border-b border-gray-200 px-6 py-4">
          <h2 className="font-semibold text-gray-900">New Chat</h2>
        </header>

        <div className="flex-1 overflow-y-auto p-6">
          <div className="max-w-4xl mx-auto">
            {/* User message */}
            <div className="flex justify-end mb-4">
              <div className="max-w-[85%] bg-indigo-600 text-white rounded-2xl rounded-br-md px-4 py-3">
                <p className="whitespace-pre-wrap">{pendingQuestionRef.current}</p>
              </div>
            </div>

            {/* Assistant response */}
            <div className="flex justify-start mb-4">
              <div className="max-w-[85%] bg-white rounded-2xl rounded-bl-md shadow-sm">
                {answer ? (
                  <div className="p-2">
                    <StructuredAnswer
                      answer={answer}
                      streamingTldr={streamingTldr}
                      streamingDetails={streamingDetails}
                      question={pendingQuestionRef.current || ''}
                    />
                  </div>
                ) : (
                  <div className="p-4">
                    <LoadingIndicator status={status} />
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>

        <div className="bg-white border-t border-gray-200 p-4">
          <div className="max-w-4xl mx-auto">
            <QuestionInput onSubmit={handleSubmit} disabled={isStreaming} />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col h-full bg-gradient-to-br from-blue-50 to-indigo-100">
      {/* Chat Header */}
      <header className="bg-white border-b border-gray-200 px-6 py-4 flex items-center justify-between">
        <div>
          <h2 className="font-semibold text-gray-900">
            {currentChat?.title || 'New Chat'}
          </h2>
          <p className="text-sm text-gray-500">
            {currentChat?.messages.length || 0} messages
          </p>
        </div>
      </header>

      {/* Messages Area */}
      <div
        ref={messagesContainerRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto p-6"
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
                  <div className="max-w-[85%] bg-white rounded-2xl rounded-bl-md shadow-sm">
                    {answer ? (
                      <div className="p-2">
                        <StructuredAnswer
                          answer={answer}
                          streamingTldr={streamingTldr}
                          streamingDetails={streamingDetails}
                          question={currentChat.messages[index - 1]?.content || ''}
                        />
                      </div>
                    ) : (
                      <div className="p-4">
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
            <div className="mb-4 bg-red-50 border-l-4 border-red-600 p-4 rounded-r-lg">
              <div className="flex items-center gap-2">
                <span className="text-2xl">⚠️</span>
                <p className="text-red-800">Error: {error}</p>
              </div>
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>
      </div>

      {/* Input Area */}
      <div className="bg-white border-t border-gray-200 p-4">
        <div className="max-w-4xl mx-auto">
          <QuestionInput onSubmit={handleSubmit} disabled={isStreaming} />
        </div>
      </div>
    </div>
  );
}
