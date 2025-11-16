import OpenAI from 'openai';

interface ModerationResult {
  flagged: boolean;
  categories: string[];
  reason?: string;
}

const OFFENSIVE_KEYWORDS = [
  'offensive',
  'explicit',
  'violence'
];

export class ModerationService {
  private client: OpenAI | null = null;

  constructor(apiKey?: string) {
    if (apiKey) {
      this.client = new OpenAI({ apiKey });
    }
  }

  async moderateInput(text: string): Promise<ModerationResult> {
    if (this.client) {
      try {
        const response = await this.client.moderations.create({
          input: text,
          model: 'text-moderation-latest'
        });

        const result = response.results[0];

        if (result.flagged) {
          const flaggedCategories = Object.entries(result.categories)
            .filter(([_, flagged]) => flagged)
            .map(([category]) => category);

          return {
            flagged: true,
            categories: flaggedCategories,
            reason: `Content flagged for: ${flaggedCategories.join(', ')}`
          };
        }

        return { flagged: false, categories: [] };
      } catch (error) {
        console.error('Moderation API error:', error);
        return this.fallbackModeration(text);
      }
    }

    return this.fallbackModeration(text);
  }

  private fallbackModeration(text: string): ModerationResult {
    const lowerText = text.toLowerCase();
    const found = OFFENSIVE_KEYWORDS.find(kw => lowerText.includes(kw));

    if (found) {
      return {
        flagged: true,
        categories: ['offensive_language'],
        reason: 'Potentially offensive content detected'
      };
    }

    return { flagged: false, categories: [] };
  }
}
