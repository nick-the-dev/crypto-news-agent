export function extractTimeRange(query: string): number {
  const lowerQuery = query.toLowerCase();

  if (lowerQuery.includes('last month') || lowerQuery.includes('past month')) {
    return 30;
  }

  if (lowerQuery.includes('two weeks') || lowerQuery.includes('2 weeks')) {
    return 14;
  }

  if (lowerQuery.includes('last week') || lowerQuery.includes('past week')) {
    return 7;
  }

  if (lowerQuery.includes('today') || lowerQuery.includes('last 24 hours')) {
    return 1;
  }

  if (lowerQuery.includes('yesterday')) {
    return 2;
  }

  return 7;
}
