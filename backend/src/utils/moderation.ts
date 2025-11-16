import OpenAI from 'openai';

interface ModerationResult {
  flagged: boolean;
  categories: string[];
  reason?: string;
}

const OFFENSIVE_KEYWORDS = [
  // Violence & Harm
  'kill',
  'murder',
  'suicide',
  'self-harm',
  'torture',
  'abuse',
  'assault',
  'weapon',
  'bomb',
  'terrorist',
  
  // Explicit/Sexual
  'porn',
  'sex',
  'nude',
  'naked',
  'explicit',
  'nsfw',
  
  // Hate Speech
  'racist',
  'nazi',
  'supremacist',
  'slur',
  'hate',
  
  // Drugs
  'cocaine',
  'heroin',
  'meth',
  'drug dealer',
  
  // Harassment
  'doxx',
  'swat',
  'harass',
  'stalk',
  'threat',
  
  // Spam/Scam
  'scam',
  'phishing',
  'fraud',
  'spam',
  
  // Crypto Scams & Fraud
  'rug pull',
  'pump and dump',
  'ponzi',
  'pyramid scheme',
  'exit scam',
  'fake airdrop',
  'honeypot',
  'doubling coins',
  'send me crypto',
  'guaranteed returns',
  '10x guaranteed',
  'risk-free profit',
  
  // Illegal Crypto Activities
  'money laundering',
  'wash trading',
  'darknet market',
  'mixer',
  'tumbler',
  'stolen funds',
  'hacked wallet',
  'private keys for sale',
  'seed phrase',
  'ransomware',
  'blackmail',
  
  // Market Manipulation
  'coordinated dump',
  'shill campaign',
  'fake volume',
  'insider trading',
  'front running',
  
  // Phishing/Theft
  'verify your wallet',
  'claim your tokens',
  'validate wallet',
  'urgent: wallet security',
  'customer support dm',
  'recovery phrase needed'
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
          model: 'omni-moderation-latest'
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
