import { StructuredAnswer as StructuredAnswerType } from '@/types';
import { ConfidenceBadge } from './ConfidenceBadge';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import ReactMarkdown from 'react-markdown';
import { ReactNode, ComponentPropsWithoutRef, useId } from 'react';
import { Newspaper, TrendingUp, TrendingDown, ExternalLink } from 'lucide-react';

interface Props {
  answer: StructuredAnswerType;
  streamingTldr?: string;
  streamingDetails?: string;
}

// Sentiment badge component
function SentimentBadge({ type }: { type: 'bullish' | 'bearish' }) {
  const isBullish = type === 'bullish';
  return (
    <Badge variant={isBullish ? 'bullish' : 'bearish'} className="gap-1">
      {isBullish ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
      {isBullish ? 'Bullish' : 'Bearish'}
    </Badge>
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
          className="text-primary hover:text-primary/80 font-semibold cursor-pointer"
        >
          {part}
        </button>
      );
    }
    return part || null;
  }).filter(Boolean);
}

// Extract citation numbers from text content (e.g., [1], [2], etc.)
function extractCitationsFromText(text: string): number[] {
  const matches = text.match(/\[(\d+)\]/g) || [];
  return [...new Set(matches.map(m => parseInt(m.slice(1, -1), 10)))];
}

export function StructuredAnswer({ answer, streamingTldr, streamingDetails }: Props) {
  const instanceId = useId();

  // Get sources that are actually referenced in the response
  const referencedSources = (() => {
    const tldrText = streamingTldr || answer.tldr || '';
    const detailsText = streamingDetails || answer.details.content || '';
    const citedNumbers = extractCitationsFromText(tldrText + detailsText);

    if (citedNumbers.length === 0) return [];

    return answer.sources
      .filter(source => citedNumbers.includes(source.number))
      .sort((a, b) => a.number - b.number);
  })();

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
            <strong className="font-bold text-foreground">{children}</strong>
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
            return <li className="text-muted-foreground">{processedChildren}</li>;
          },
          h1: ({ children }: ComponentPropsWithoutRef<'h1'>) => (
            <h3 className="text-xl font-bold text-foreground mt-6 mb-3">{children}</h3>
          ),
          h2: ({ children }: ComponentPropsWithoutRef<'h2'>) => (
            <h4 className="text-lg font-bold text-foreground mt-5 mb-2">{children}</h4>
          ),
          h3: ({ children }: ComponentPropsWithoutRef<'h3'>) => (
            <h5 className="text-base font-bold text-foreground mt-4 mb-2">{children}</h5>
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    );
  };

  return (
    <div className="w-full max-w-4xl mx-auto">
      <Card>
        <CardContent className="pt-4 sm:pt-6">
          <div className="text-muted-foreground leading-relaxed text-sm sm:text-base">
            {/* TL;DR section - only show header and confidence when there are sources */}
            <div className="mb-3 sm:mb-4">
              {answer.sources.length > 0 && (
                <div className="flex items-center justify-between gap-2 mb-1">
                  <h4 className="text-xs sm:text-sm font-semibold text-muted-foreground uppercase tracking-wide">TL;DR</h4>
                  <ConfidenceBadge score={answer.confidence} />
                </div>
              )}
              <div className={`text-foreground ${answer.sources.length > 0 ? 'text-base sm:text-lg font-semibold mb-2' : 'text-sm sm:text-base'}`}>
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
                {streamingTldr && !streamingDetails && <span className="inline-block w-2 h-4 sm:h-5 bg-primary animate-pulse ml-1"></span>}
              </div>
            </div>

            {/* Details section */}
            {(streamingDetails || answer.details.content) && (
              <div className="text-muted-foreground mb-4 sm:mb-6">
                {streamingDetails ? (
                  <>
                    {renderMarkdownContent(streamingDetails)}
                    <span className="inline-block w-2 h-4 sm:h-5 bg-primary animate-pulse ml-1"></span>
                  </>
                ) : (
                  renderMarkdownContent(answer.details.content)
                )}
              </div>
            )}

            {/* Sources as compact tiles - only show sources referenced in the response */}
            {referencedSources.length > 0 && (
              <div className="pt-3 sm:pt-4 border-t border-border">
                <h3 className="text-xs sm:text-sm font-semibold text-muted-foreground mb-2 sm:mb-3 flex items-center gap-1.5">
                  <Newspaper className="h-4 w-4" />
                  Sources
                </h3>
                <div className="flex flex-wrap gap-1.5 sm:gap-2">
                  {referencedSources.map((source) => {
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
                        className="group inline-flex items-center gap-1 sm:gap-1.5 px-1.5 sm:px-2 py-1 sm:py-1.5 bg-muted hover:bg-primary/10 border border-border hover:border-primary/50 rounded-lg transition-all max-w-full"
                      >
                        <Badge variant="default" className="shrink-0 h-4 w-4 rounded-full p-0 flex items-center justify-center text-[10px] font-bold">
                          {source.number}
                        </Badge>
                        <div className="flex flex-col items-start min-w-0">
                          <span className="font-medium text-foreground group-hover:text-primary text-[10px] sm:text-xs truncate max-w-[150px] sm:max-w-none sm:whitespace-nowrap">
                            {source.title}
                          </span>
                          <span className="text-[9px] sm:text-[10px] text-muted-foreground whitespace-nowrap">
                            {source.source} • {timeAgo}
                          </span>
                        </div>
                        <ExternalLink className="h-3 w-3 opacity-0 group-hover:opacity-100 transition-opacity text-primary shrink-0" />
                      </a>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
