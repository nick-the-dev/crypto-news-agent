import { useState } from 'react';
import { StructuredAnswer as StructuredAnswerType } from '../types';
import { ConfidenceBadge } from './ConfidenceBadge';
import { SourceCard } from './SourceCard';

interface Props {
  answer: StructuredAnswerType;
  streamingTldr?: string;
  streamingDetails?: string;
}

export function StructuredAnswer({ answer, streamingTldr, streamingDetails }: Props) {

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
      <div className="bg-blue-50 border-l-4 border-blue-600 p-4 rounded-r-lg">
        <div className="flex items-center gap-2 mb-2">
          <span className="text-2xl">⚡</span>
          <h2 className="text-lg font-bold text-gray-900">TL;DR</h2>
        </div>
        <p className="text-gray-800 text-lg">
          {streamingTldr || answer.tldr}
          {streamingTldr && <span className="inline-block w-2 h-5 bg-blue-600 animate-pulse ml-1"></span>}
        </p>
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
          {streamingDetails ? (
            <>
              {renderWithCitations(streamingDetails)}
              <span className="inline-block w-2 h-5 bg-blue-600 animate-pulse ml-1"></span>
            </>
          ) : (
            renderWithCitations(answer.details.content)
          )}
        </div>
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
