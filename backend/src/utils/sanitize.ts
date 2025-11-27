/**
 * Centralized Input Sanitization Utility
 *
 * Provides sanitization functions to prevent:
 * - SQL injection
 * - Prompt injection attacks
 * - XSS attacks
 * - Log injection
 * - Command injection
 */

// Characters that could be used for prompt injection attacks
const PROMPT_INJECTION_PATTERNS = [
  /ignore\s+(all\s+)?(previous|above|prior)\s+(instructions?|prompts?|rules?)/gi,
  /disregard\s+(all\s+)?(previous|above|prior)/gi,
  /forget\s+(all\s+)?(previous|above|prior)/gi,
  /you\s+are\s+now\s+/gi,
  /new\s+instructions?:/gi,
  /system\s*:\s*/gi,
  /assistant\s*:\s*/gi,
  /user\s*:\s*/gi,
  /\[\s*INST\s*\]/gi,
  /\[\s*\/INST\s*\]/gi,
  /<\|im_start\|>/gi,
  /<\|im_end\|>/gi,
  /<<SYS>>/gi,
  /<\/SYS>/gi,
];

// Dangerous characters for SQL-like operations
const SQL_DANGEROUS_CHARS = /[;'"\\`\x00-\x1f]/g;

// Characters that could be used for log injection
const LOG_DANGEROUS_CHARS = /[\r\n\x00-\x08\x0b\x0c\x0e-\x1f]/g;

/**
 * Sanitize input for use in database queries (lexical search)
 * Removes potentially dangerous characters while preserving search functionality
 */
export function sanitizeForSearch(input: string): string {
  if (!input || typeof input !== 'string') {
    return '';
  }

  return input
    // Remove SQL-dangerous characters
    .replace(SQL_DANGEROUS_CHARS, '')
    // Remove backslashes that could escape
    .replace(/\\/g, '')
    // Remove null bytes
    .replace(/\0/g, '')
    // Normalize whitespace
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Sanitize input for use in LLM prompts to prevent prompt injection
 * Returns object with sanitized input and whether suspicious patterns were detected
 */
export function sanitizeForLLM(input: string): { sanitized: string; suspicious: boolean } {
  if (!input || typeof input !== 'string') {
    return { sanitized: '', suspicious: false };
  }

  let suspicious = false;
  let sanitized = input;

  // Check for prompt injection patterns
  for (const pattern of PROMPT_INJECTION_PATTERNS) {
    if (pattern.test(sanitized)) {
      suspicious = true;
      // Reset lastIndex for global regexes
      pattern.lastIndex = 0;
    }
  }

  // Remove or escape potentially dangerous sequences
  sanitized = sanitized
    // Remove any attempted role markers
    .replace(/\[\s*(system|user|assistant)\s*\]/gi, '')
    // Remove markdown code block attempts to inject system prompts
    .replace(/```\s*(system|prompt|instruction)/gi, '```')
    // Escape angle brackets that could be used for XML-style injection
    .replace(/</g, '＜')
    .replace(/>/g, '＞')
    // Remove null bytes
    .replace(/\0/g, '')
    // Normalize whitespace
    .replace(/\s+/g, ' ')
    .trim();

  return { sanitized, suspicious };
}

/**
 * Sanitize input for safe logging (prevents log injection/forging)
 */
export function sanitizeForLog(input: string): string {
  if (!input || typeof input !== 'string') {
    return '';
  }

  return input
    // Remove control characters that could forge log entries
    .replace(LOG_DANGEROUS_CHARS, '')
    // Replace newlines with escaped versions for single-line logging
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    // Limit length to prevent log flooding
    .substring(0, 1000);
}

/**
 * Improved HTML sanitization that handles more edge cases
 * For external content like RSS feeds
 */
export function sanitizeHtml(html: string): string {
  if (!html || typeof html !== 'string') {
    return '';
  }

  let text = html
    // Remove script tags and their contents
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    // Remove style tags and their contents
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
    // Remove on* event handlers
    .replace(/\s+on\w+\s*=\s*["'][^"']*["']/gi, '')
    .replace(/\s+on\w+\s*=\s*[^\s>]*/gi, '')
    // Remove javascript: and data: URLs
    .replace(/\bhref\s*=\s*["']?\s*javascript:[^"'\s>]*/gi, '')
    .replace(/\bsrc\s*=\s*["']?\s*javascript:[^"'\s>]*/gi, '')
    .replace(/\bhref\s*=\s*["']?\s*data:[^"'\s>]*/gi, '')
    .replace(/\bsrc\s*=\s*["']?\s*data:[^"'\s>]*/gi, '')
    // Remove all HTML tags
    .replace(/<[^>]*>/g, '');

  // Decode common HTML entities
  const entities: Record<string, string> = {
    '&amp;': '&',
    '&lt;': '<',
    '&gt;': '>',
    '&quot;': '"',
    '&#039;': "'",
    '&apos;': "'",
    '&nbsp;': ' ',
    '&#x27;': "'",
    '&#x2F;': '/',
    '&#60;': '<',
    '&#62;': '>',
  };

  for (const [entity, char] of Object.entries(entities)) {
    text = text.replace(new RegExp(entity, 'gi'), char);
  }

  // Decode numeric HTML entities
  text = text.replace(/&#(\d+);/g, (_, code) => {
    const num = parseInt(code, 10);
    // Only decode safe printable characters
    if (num >= 32 && num <= 126) {
      return String.fromCharCode(num);
    }
    return '';
  });

  // Normalize whitespace
  text = text.replace(/\s+/g, ' ').trim();

  return text;
}

/**
 * Validate and sanitize user question input
 * Returns sanitized input and any validation errors
 */
export function validateUserQuestion(input: unknown): {
  valid: boolean;
  sanitized: string;
  error?: string;
} {
  // Type check
  if (!input || typeof input !== 'string') {
    return { valid: false, sanitized: '', error: 'Question is required and must be a string' };
  }

  const trimmed = input.trim();

  // Length check
  if (trimmed.length === 0) {
    return { valid: false, sanitized: '', error: 'Question cannot be empty' };
  }

  if (trimmed.length > 500) {
    return { valid: false, sanitized: '', error: 'Question too long (max 500 characters)' };
  }

  // Check for prompt injection
  const { sanitized, suspicious } = sanitizeForLLM(trimmed);

  // Log if suspicious but don't necessarily block
  // The moderation service provides additional checking

  return {
    valid: true,
    sanitized,
    error: suspicious ? 'Input contained suspicious patterns that were sanitized' : undefined,
  };
}

/**
 * Escape special regex characters in a string
 * Use this when building RegExp from user input
 */
export function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Sanitize lexical search terms for PostgreSQL full-text search
 * Ensures terms are safe for use in tsquery
 */
export function sanitizeLexicalTerms(query: string): string {
  return query
    .split(/\s+/)
    .filter(t => t.length > 2)
    // Only allow word characters (letters, numbers, underscore)
    .map(t => t.replace(/[^\w]/g, ''))
    // Remove empty terms
    .filter(Boolean)
    // Limit number of terms to prevent abuse
    .slice(0, 20)
    .join(' | ');
}
