import { ArticleSource } from '@/types';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ExternalLink } from 'lucide-react';

interface Props extends ArticleSource {
  id: string;
}

export function SourceCard({ number, title, source, url, publishedAt, id }: Props) {
  const publishedDate = new Date(publishedAt);
  const hoursAgo = Math.round((Date.now() - publishedDate.getTime()) / (1000 * 60 * 60));
  const timeAgo = hoursAgo < 24
    ? `${hoursAgo} hours ago`
    : `${Math.round(hoursAgo / 24)} days ago`;

  return (
    <Card
      id={id}
      className="p-3 hover:border-primary/50 transition-all group"
    >
      <div className="flex items-start gap-2">
        <Badge variant="default" className="shrink-0 h-6 w-6 rounded-full p-0 flex items-center justify-center text-xs font-bold">
          {number}
        </Badge>
        <div className="flex-1 min-w-0">
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="font-semibold text-foreground hover:text-primary text-sm block mb-1 line-clamp-2 group-hover:underline"
          >
            {title}
            <ExternalLink className="inline-block ml-1 h-3 w-3 opacity-0 group-hover:opacity-100 transition-opacity" />
          </a>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className="font-medium">{source}</span>
            <span>•</span>
            <span>{timeAgo}</span>
          </div>
        </div>
      </div>
    </Card>
  );
}
