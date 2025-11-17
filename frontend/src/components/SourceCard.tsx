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
      className="bg-white border border-gray-200 rounded-lg p-3 hover:border-blue-400 transition-all"
    >
      <div className="flex items-start gap-2">
        <div className="flex-shrink-0 w-6 h-6 bg-blue-600 text-white rounded-full flex items-center justify-center font-bold text-sm">
          {number}
        </div>
        <div className="flex-1 min-w-0">
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="font-semibold text-gray-900 hover:text-blue-600 text-sm block mb-1 line-clamp-2"
          >
            {title}
          </a>
          <div className="flex items-center gap-2 text-xs text-gray-500">
            <span className="font-medium">{source}</span>
            <span>•</span>
            <span>{timeAgo}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
