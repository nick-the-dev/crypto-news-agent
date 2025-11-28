import { Badge } from '@/components/ui/badge';

interface Props {
  score: number;
}

function getVariant(score: number): "success" | "info" | "warning" | "caution" | "low" {
  if (score >= 80) return 'success';
  if (score >= 60) return 'info';
  if (score >= 40) return 'warning';
  if (score >= 20) return 'caution';
  return 'low';
}

function getLabel(score: number): string {
  if (score >= 80) return 'High';
  if (score >= 60) return 'Good';
  if (score >= 40) return 'Moderate';
  if (score >= 20) return 'Low';
  return 'Very Low';
}

export function ConfidenceBadge({ score }: Props) {
  return (
    <Badge variant={getVariant(score)} className="gap-1.5">
      <span className="font-medium">{getLabel(score)}</span>
      <span className="opacity-75">{score}%</span>
    </Badge>
  );
}
