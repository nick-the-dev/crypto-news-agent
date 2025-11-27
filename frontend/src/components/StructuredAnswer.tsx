import { StructuredAnswer as StructuredAnswerType } from '../types';
import { ConfidenceBadge } from './ConfidenceBadge';
import ReactMarkdown from 'react-markdown';
import { ReactNode, ComponentPropsWithoutRef, useId } from 'react';

interface Props {
  answer: StructuredAnswerType;
  streamingTldr?: string;
  streamingDetails?: string;
  question?: string;
}

// Sentiment badge component
function SentimentBadge({ type }: { type: 'bullish' | 'bearish' }) {
  const isBullish = type === 'bullish';
  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold ${
        isBullish
          ? 'bg-green-100 text-green-800 border border-green-300'
          : 'bg-red-100 text-red-800 border border-red-300'
      }`}
    >
      {isBullish ? '📈' : '📉'}
      {isBullish ? 'Bullish' : 'Bearish'}
    </span>
  );
}

// Process text to replace [BULLISH], [BEARISH], and citations with React components
function processTextWithTags(text: string, onCitationClick: (num: number) => void): ReactNode[] {
  const parts = text.split(/(\[BULLISH\]|\[BEARISH\]|\[\d+\])/g);

  return parts.map((part, i) => {
    if (part === '[BULLISH]') {
      return <SentimentBadge key={i} type="bullish" />;
    }
    if (part === '[BEARISH]') {
      return <SentimentBadge key={i} type="bearish" />;
    }
    const citationMatch = part.match(/^\[(\d+)\]$/);
    if (citationMatch) {
      return (
        <button
          key={i}
          type="button"
          onClick={() => onCitationClick(+citationMatch[1])}
          className="text-blue-600 hover:text-blue-800 font-semibold cursor-pointer"
        >
          {part}
        </button>
      );
    }
    return part || null;
  }).filter(Boolean);
}

export function StructuredAnswer({ answer, streamingTldr, streamingDetails, question }: Props) {
  const instanceId = useId();

  const handleCitationClick = (num: number) => {
    // Use requestAnimationFrame to ensure DOM is ready
    requestAnimationFrame(() => {
      // Scope lookup to this component instance using the unique ID
      const element = document.getElementById(`${instanceId}-source-${num}`);
      if (!element) return;

      // Find the scrollable parent container
      let scrollParent: HTMLElement | null = element.parentElement;
      while (scrollParent) {
        const overflow = getComputedStyle(scrollParent).overflowY;
        if (overflow === 'auto' || overflow === 'scroll') {
          break;
        }
        scrollParent = scrollParent.parentElement;
      }

      if (scrollParent) {
        // Calculate position relative to scroll container
        const elementRect = element.getBoundingClientRect();
        const containerRect = scrollParent.getBoundingClientRect();
        const scrollTop = scrollParent.scrollTop + (elementRect.top - containerRect.top) - (containerRect.height / 2) + (elementRect.height / 2);

        scrollParent.scrollTo({
          top: scrollTop,
          behavior: 'smooth'
        });
      } else {
        // Fallback to scrollIntoView
        element.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }

      // Use inline styles for highlight since Tailwind may purge dynamic classes
      element.style.boxShadow = '0 0 0 4px rgb(96, 165, 250)';
      element.style.transition = 'box-shadow 0.3s ease';
      setTimeout(() => {
        element.style.boxShadow = '';
      }, 2000);
    });
  };

  // Process children to handle text nodes with tags
  const processChildren = (children: ReactNode): ReactNode => {
    if (typeof children === 'string') {
      return processTextWithTags(children, handleCitationClick);
    }
    if (Array.isArray(children)) {
      return children.map((child, i) => {
        if (typeof child === 'string') {
          return <span key={i}>{processTextWithTags(child, handleCitationClick)}</span>;
        }
        return child;
      });
    }
    return children;
  };

  // Render markdown with custom text processing for tags
  const renderMarkdownContent = (content: string): ReactNode => {
    return (
      <ReactMarkdown
        components={{
          // Handle text nodes to process tags and citations
          p: ({ children }: ComponentPropsWithoutRef<'p'>) => {
            const processedChildren = processChildren(children);
            return <p className="mb-3">{processedChildren}</p>;
          },
          strong: ({ children }: ComponentPropsWithoutRef<'strong'>) => (
            <strong className="font-bold text-gray-900">{children}</strong>
          ),
          em: ({ children }: ComponentPropsWithoutRef<'em'>) => (
            <em className="italic">{children}</em>
          ),
          ul: ({ children }: ComponentPropsWithoutRef<'ul'>) => (
            <ul className="list-disc ml-6 my-3 space-y-1">{children}</ul>
          ),
          ol: ({ children }: ComponentPropsWithoutRef<'ol'>) => (
            <ol className="list-decimal ml-6 my-3 space-y-1">{children}</ol>
          ),
          li: ({ children }: ComponentPropsWithoutRef<'li'>) => {
            const processedChildren = processChildren(children);
            return <li className="text-gray-700">{processedChildren}</li>;
          },
          h1: ({ children }: ComponentPropsWithoutRef<'h1'>) => (
            <h3 className="text-xl font-bold text-gray-900 mt-6 mb-3">{children}</h3>
          ),
          h2: ({ children }: ComponentPropsWithoutRef<'h2'>) => (
            <h4 className="text-lg font-bold text-gray-900 mt-5 mb-2">{children}</h4>
          ),
          h3: ({ children }: ComponentPropsWithoutRef<'h3'>) => (
            <h5 className="text-base font-bold text-gray-900 mt-4 mb-2">{children}</h5>
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    );
  };

  return (
    <div className="w-full max-w-4xl mx-auto space-y-4 sm:space-y-6">
      {/* Question Display */}
      {question && (
        <div className="bg-gradient-to-r from-blue-50 to-indigo-50 border border-blue-200 rounded-lg p-3 sm:p-4">
          <div className="flex items-start gap-2 sm:gap-3">
            <span className="text-xl sm:text-2xl flex-shrink-0">❓</span>
            <div className="min-w-0">
              <h3 className="text-xs sm:text-sm font-semibold text-gray-600 mb-1">Your Question</h3>
              <p className="text-gray-900 text-base sm:text-lg">{question}</p>
            </div>
          </div>
        </div>
      )}

      {/* Answer Display */}
      <div className="bg-white border border-gray-200 rounded-lg p-4 sm:p-6">
        <div className="flex items-center justify-between mb-3 sm:mb-4 gap-2">
          <div className="flex items-center gap-2">
            <span className="text-xl sm:text-2xl">💡</span>
            <h2 className="text-lg sm:text-xl font-bold text-gray-900">Answer</h2>
          </div>
          <ConfidenceBadge score={answer.confidence} />
        </div>
        <div className="text-gray-700 leading-relaxed text-sm sm:text-base">
          {/* TL;DR section */}
          <div className="mb-3 sm:mb-4">
            <h4 className="text-xs sm:text-sm font-semibold text-gray-500 uppercase tracking-wide mb-1">TL;DR</h4>
            <div className="text-base sm:text-lg font-semibold text-gray-900 mb-2">
              <ReactMarkdown
                components={{
                  p: ({ children }: ComponentPropsWithoutRef<'p'>) => <span>{children}</span>,
                  strong: ({ children }: ComponentPropsWithoutRef<'strong'>) => (
                    <strong className="font-bold">{children}</strong>
                  ),
                }}
              >
                {streamingTldr || answer.tldr}
              </ReactMarkdown>
              {streamingTldr && !streamingDetails && <span className="inline-block w-2 h-4 sm:h-5 bg-blue-600 animate-pulse ml-1"></span>}
            </div>
          </div>

          {/* Details section */}
          {(streamingDetails || answer.details.content) && (
            <div className="text-gray-700 mb-4 sm:mb-6">
              {streamingDetails ? (
                <>
                  {renderMarkdownContent(streamingDetails)}
                  <span className="inline-block w-2 h-4 sm:h-5 bg-blue-600 animate-pulse ml-1"></span>
                </>
              ) : (
                renderMarkdownContent(answer.details.content)
              )}
            </div>
          )}

          {/* Sources as compact tiles */}
          {answer.sources.length > 0 && (
            <div className="pt-3 sm:pt-4 border-t border-gray-200">
              <h3 className="text-xs sm:text-sm font-semibold text-gray-600 mb-2 sm:mb-3">📰 Sources</h3>
              <div className="flex flex-wrap gap-1.5 sm:gap-2">
                {answer.sources.map((source) => {
                  const publishedDate = new Date(source.publishedAt);
                  const hoursAgo = Math.round((Date.now() - publishedDate.getTime()) / (1000 * 60 * 60));
                  const timeAgo = hoursAgo < 24
                    ? `${hoursAgo}h ago`
                    : `${Math.round(hoursAgo / 24)}d ago`;

                  return (
                    <a
                      key={source.number}
                      id={`${instanceId}-source-${source.number}`}
                      href={source.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="group inline-flex items-center gap-1 sm:gap-1.5 px-1.5 sm:px-2 py-1 sm:py-1.5 bg-gray-50 hover:bg-blue-50 border border-gray-200 hover:border-blue-400 rounded-lg transition-all max-w-full"
                    >
                      <span className="flex-shrink-0 w-4 h-4 bg-blue-600 text-white rounded-full flex items-center justify-center font-bold text-[10px]">
                        {source.number}
                      </span>
                      <div className="flex flex-col items-start min-w-0">
                        <span className="font-medium text-gray-900 group-hover:text-blue-600 text-[10px] sm:text-xs truncate max-w-[150px] sm:max-w-none sm:whitespace-nowrap">
                          {source.title}
                        </span>
                        <span className="text-[9px] sm:text-[10px] text-gray-500 whitespace-nowrap">
                          {source.source} • {timeAgo}
                        </span>
                      </div>
                    </a>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
