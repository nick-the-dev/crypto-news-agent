export interface ParsedResponse {
  tldr: string;
  details: {
    content: string;
    citations: number[];
  };
  confidence: number;
}

export interface ValidationResult {
  valid: boolean;
  issues: string[];
}

function extractSection(text: string, sectionName: string): string {
  const regex = new RegExp(`##\\s*${sectionName}\\s*\\n([\\s\\S]*?)(?=##|$)`, 'i');
  const match = text.match(regex);
  return match ? match[1].trim() : '';
}

function extractCitations(text: string): number[] {
  const citationRegex = /\[(\d+)\]/g;
  const citations = new Set<number>();
  let match;

  while ((match = citationRegex.exec(text)) !== null) {
    citations.add(parseInt(match[1], 10));
  }

  return Array.from(citations).sort((a, b) => a - b);
}

function extractConfidence(text: string): number {
  const confidenceSection = extractSection(text, 'Confidence');
  const numberMatch = confidenceSection.match(/(\d+)%?/);

  if (!numberMatch) return 50;

  const confidence = parseInt(numberMatch[1], 10);
  return Math.max(1, Math.min(100, confidence));
}

export function parseStructuredResponse(rawResponse: string): ParsedResponse {
  const tldr = extractSection(rawResponse, 'TL;?DR');
  const detailsContent = extractSection(rawResponse, 'Details');
  const confidence = extractConfidence(rawResponse);

  return {
    tldr: tldr || 'No summary available',
    details: {
      content: detailsContent || 'No details available',
      citations: extractCitations(detailsContent)
    },
    confidence
  };
}

export function validateCitations(
  parsed: ParsedResponse,
  sourceCount: number
): ValidationResult {
  const issues: string[] = [];
  const allCitations = parsed.details.citations;

  for (const citation of allCitations) {
    if (citation < 1 || citation > sourceCount) {
      issues.push(`Invalid citation [${citation}] - only ${sourceCount} sources available`);
    }
  }

  if (parsed.details.content.length > 100 && parsed.details.citations.length === 0) {
    issues.push('Details section lacks citations despite having substantial content');
  }

  return {
    valid: issues.length === 0,
    issues
  };
}
