import { StructuredAnswer as StructuredAnswerType } from '../types';
import { ConfidenceBadge } from './ConfidenceBadge';

interface Props {
  answer: StructuredAnswerType;
  streamingTldr?: string;
  streamingDetails?: string;
  question?: string;
}

export function StructuredAnswer({ answer, streamingTldr, streamingDetails, question }: Props) {

  const handleCitationClick = (num: number) => {
    const element = document.getElementById(`source-${num}`);
    element?.scrollIntoView({ behavior: 'smooth', block: 'center' });

    element?.classList.add('ring-4', 'ring-blue-400');
    setTimeout(() => {
      element?.classList.remove('ring-4', 'ring-blue-400');
    }, 2000);
  };

  const renderWithCitations = (content: string) => {
    const parts = content.split(/(\[\d+\])/g);
    return parts.map((part, i) => {
      const match = part.match(/\[(\d+)\]/);
      if (match) {
        return (
          <button
            key={i}
            onClick={() => handleCitationClick(+match[1])}
            className="text-blue-600 hover:text-blue-800 font-semibold cursor-pointer"
          >
            {part}
          </button>
        );
      }
      return <span key={i}>{part}</span>;
    });
  };

  return (
    <div className="w-full max-w-4xl mx-auto space-y-6">
      {/* Question Display */}
      {question && (
        <div className="bg-gradient-to-r from-blue-50 to-indigo-50 border border-blue-200 rounded-lg p-4">
          <div className="flex items-start gap-3">
            <span className="text-2xl flex-shrink-0">❓</span>
            <div>
              <h3 className="text-sm font-semibold text-gray-600 mb-1">Your Question</h3>
              <p className="text-gray-900 text-lg">{question}</p>
            </div>
          </div>
        </div>
      )}

      {/* Answer Display */}
      <div className="bg-white border border-gray-200 rounded-lg p-6">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <span className="text-2xl">💡</span>
            <h2 className="text-xl font-bold text-gray-900">Answer</h2>
          </div>
          <ConfidenceBadge score={answer.confidence} />
        </div>
        <div className="text-gray-700 leading-relaxed">
          {/* TL;DR section */}
          <div className="mb-4">
            <p className="text-lg font-semibold text-gray-900 mb-2">
              {streamingTldr || answer.tldr}
              {streamingTldr && !streamingDetails && <span className="inline-block w-2 h-5 bg-blue-600 animate-pulse ml-1"></span>}
            </p>
          </div>

          {/* Details section */}
          {(streamingDetails || answer.details.content) && (
            <div className="text-gray-700 whitespace-pre-wrap mb-6">
              {streamingDetails ? (
                <>
                  {renderWithCitations(streamingDetails)}
                  <span className="inline-block w-2 h-5 bg-blue-600 animate-pulse ml-1"></span>
                </>
              ) : (
                renderWithCitations(answer.details.content)
              )}
            </div>
          )}

          {/* Sources as compact tiles */}
          {answer.sources.length > 0 && (
            <div className="pt-4 border-t border-gray-200">
              <h3 className="text-sm font-semibold text-gray-600 mb-3">📰 Sources</h3>
              <div className="flex flex-wrap gap-2">
                {answer.sources.map((source) => {
                  const publishedDate = new Date(source.publishedAt);
                  const hoursAgo = Math.round((Date.now() - publishedDate.getTime()) / (1000 * 60 * 60));
                  const timeAgo = hoursAgo < 24
                    ? `${hoursAgo}h ago`
                    : `${Math.round(hoursAgo / 24)}d ago`;

                  return (
                    <a
                      key={source.number}
                      id={`source-${source.number}`}
                      href={source.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="group flex-shrink-0 inline-flex items-center gap-1.5 px-2 py-1.5 bg-gray-50 hover:bg-blue-50 border border-gray-200 hover:border-blue-400 rounded-lg transition-all"
                    >
                      <span className="flex-shrink-0 w-4 h-4 bg-blue-600 text-white rounded-full flex items-center justify-center font-bold text-[10px]">
                        {source.number}
                      </span>
                      <div className="flex flex-col items-start">
                        <span className="font-medium text-gray-900 group-hover:text-blue-600 whitespace-nowrap text-xs">
                          {source.title}
                        </span>
                        <span className="text-[10px] text-gray-500 whitespace-nowrap">
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
