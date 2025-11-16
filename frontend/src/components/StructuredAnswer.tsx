import { useState } from 'react';
import { StructuredAnswer as StructuredAnswerType } from '../types';
import { ConfidenceBadge } from './ConfidenceBadge';
import { SourceCard } from './SourceCard';

interface Props {
  answer: StructuredAnswerType;
  streamingTokens?: string[];
}

export function StructuredAnswer({ answer, streamingTokens }: Props) {
  const [contextExpanded, setContextExpanded] = useState(false);

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

  const streamingContent = streamingTokens?.join('') || '';

  return (
    <div className="w-full max-w-4xl mx-auto space-y-6">
      <div className="bg-blue-50 border-l-4 border-blue-600 p-4 rounded-r-lg">
        <div className="flex items-center gap-2 mb-2">
          <span className="text-2xl">⚡</span>
          <h2 className="text-lg font-bold text-gray-900">TL;DR</h2>
        </div>
        <p className="text-gray-800 text-lg">{answer.tldr}</p>
      </div>

      <div className="bg-white border border-gray-200 rounded-lg p-6">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <span className="text-2xl">📊</span>
            <h2 className="text-xl font-bold text-gray-900">Details</h2>
          </div>
          <ConfidenceBadge score={answer.confidence} />
        </div>
        <div className="text-gray-700 leading-relaxed whitespace-pre-wrap">
          {renderWithCitations(answer.details.content)}
          {streamingContent && <span className="inline-block w-2 h-5 bg-blue-600 animate-pulse ml-1"></span>}
        </div>
      </div>

      <div className="bg-white border border-gray-200 rounded-lg p-6">
        <button
          onClick={() => setContextExpanded(!contextExpanded)}
          className="flex items-center justify-between w-full text-left"
        >
          <div className="flex items-center gap-2">
            <span className="text-2xl">📖</span>
            <h2 className="text-xl font-bold text-gray-900">Context</h2>
          </div>
          <span className="text-gray-500">{contextExpanded ? '▼' : '▶'}</span>
        </button>
        {contextExpanded && (
          <div className="mt-4 text-gray-700 leading-relaxed whitespace-pre-wrap">
            {renderWithCitations(answer.context.content)}
          </div>
        )}
      </div>

      <div>
        <h2 className="text-2xl font-bold text-gray-900 mb-4">📰 Sources</h2>
        <div className="grid gap-4">
          {answer.sources.map((source) => (
            <SourceCard
              key={source.number}
              {...source}
              id={`source-${source.number}`}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
