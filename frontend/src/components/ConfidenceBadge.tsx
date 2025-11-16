interface Props {
  score: number;
}

export function ConfidenceBadge({ score }: Props) {
  const getConfig = (score: number) => {
    if (score >= 80) return { label: 'High', color: 'green', icon: '✓' };
    if (score >= 60) return { label: 'Good', color: 'blue', icon: '○' };
    if (score >= 40) return { label: 'Medium', color: 'yellow', icon: '◐' };
    return { label: 'Low', color: 'orange', icon: '!' };
  };

  const config = getConfig(score);
  const colorClasses = {
    green: 'bg-green-100 text-green-800 border-green-300',
    blue: 'bg-blue-100 text-blue-800 border-blue-300',
    yellow: 'bg-yellow-100 text-yellow-800 border-yellow-300',
    orange: 'bg-orange-100 text-orange-800 border-orange-300'
  };

  return (
    <div className="inline-flex items-center gap-2">
      <div className={`px-3 py-1 rounded-full border ${colorClasses[config.color as keyof typeof colorClasses]}`}>
        <span className="font-semibold">{config.icon} {config.label}</span>
        <span className="ml-2">{score}%</span>
      </div>
      <div className="w-32 h-2 bg-gray-200 rounded-full overflow-hidden">
        <div
          className="h-full bg-blue-600"
          style={{ width: `${score}%` }}
        ></div>
      </div>
    </div>
  );
}
