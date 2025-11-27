import { sanitizeHtml as secureSanitizeHtml } from './sanitize';

/**
 * Strip HTML tags and decode entities from text
 * Uses secure sanitization to prevent XSS attacks
 */
export function stripHtml(html: string): string {
  // Use the secure sanitization function that handles:
  // - Script/style tag removal
  // - Event handler removal (onclick, onerror, etc.)
  // - javascript: and data: URL removal
  // - All HTML tag stripping
  // - HTML entity decoding
  return secureSanitizeHtml(html);
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
