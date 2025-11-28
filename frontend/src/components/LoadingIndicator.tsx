import { Spinner } from '@/components/ui/spinner';
import { Skeleton } from '@/components/ui/skeleton';

interface Props {
  status: string;
}

export function LoadingIndicator({ status }: Props) {
  return (
    <div className="flex flex-col items-center justify-center py-12">
      <div className="relative mb-4">
        <Spinner size="lg" className="text-primary" />
        <span className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 text-2xl">
          🤖
        </span>
      </div>
      <p className="text-muted-foreground mb-4">{status}</p>
      <div className="w-full max-w-md space-y-3">
        <Skeleton className="h-4 w-3/4" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-5/6" />
      </div>
    </div>
  );
}
