import { ArticleSource } from '../types';

interface Props extends ArticleSource {
  id: string;
}

export function SourceCard({ number, title, source, url, publishedAt, relevance, id }: Props) {
  const publishedDate = new Date(publishedAt);
  const hoursAgo = Math.round((Date.now() - publishedDate.getTime()) / (1000 * 60 * 60));
  const timeAgo = hoursAgo < 24
    ? `${hoursAgo} hours ago`
    : `${Math.round(hoursAgo / 24)} days ago`;

  return (
    <div
      id={id}
      className="bg-white border border-gray-200 rounded-lg p-4 hover:border-blue-400 transition-all"
    >
      <div className="flex items-start gap-3">
        <div className="flex-shrink-0 w-8 h-8 bg-blue-600 text-white rounded-full flex items-center justify-center font-bold">
          {number}
        </div>
        <div className="flex-1">
          <h3 className="font-bold text-gray-900 mb-2">{title}</h3>
          <div className="flex items-center gap-2 text-sm text-gray-600 mb-2">
            <span className="font-medium">{source}</span>
            <span>•</span>
            <span>{timeAgo}</span>
            <span>•</span>
            <span className="px-2 py-0.5 bg-blue-100 text-blue-800 rounded">{relevance}% relevant</span>
          </div>
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-blue-600 hover:text-blue-800 text-sm inline-flex items-center gap-1"
          >
            Read full article →
          </a>
        </div>
      </div>
    </div>
  );
}
