interface Props {
  score: number;
}

export function ConfidenceBadge({ score }: Props) {
  const getColor = (score: number) => {
    if (score >= 80) return 'bg-green-100 text-green-800 border-green-300';
    if (score >= 60) return 'bg-blue-100 text-blue-800 border-blue-300';
    if (score >= 40) return 'bg-yellow-100 text-yellow-800 border-yellow-300';
    return 'bg-orange-100 text-orange-800 border-orange-300';
  };

  return (
    <div className={`px-3 py-1 rounded-full border ${getColor(score)}`}>
      <span className="font-semibold">Confidence: {score}%</span>
    </div>
  );
}
