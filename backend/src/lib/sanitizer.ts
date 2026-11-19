/**
 * sanitizer.ts
 *
 * Content sanitization to prevent script injection attacks.
 * Removes or escapes HTML/script tags while preserving plain text and safe formatting.
 */

import DOMPurify from "isomorphic-dompurify";

/**
 * Sanitize a chat message body to prevent script injection.
 * Strips all HTML tags and script content, returning plain text.
 *
 * @param body - The message body to sanitize
 * @returns Sanitized plain text
 */
export function sanitizeMessageBody(body: string): string {
  if (!body || typeof body !== "string") {
    return "";
  }

  // Strip all HTML tags and return plain text content
  // ALLOWED_TAGS: [] ensures no HTML tags are preserved, only text content
  const cleaned = DOMPurify.sanitize(body, { ALLOWED_TAGS: [] });

  // Trim and return
  return cleaned.trim();
}

/**
 * Validate that a string looks like a URL (basic check).
 * Used to detect potential malicious links like javascript:alert(1).
 *
 * @param text - The text to check
 * @returns true if the text contains a dangerous protocol
 */
export function containsDangerousProtocol(text: string): boolean {
  // Match dangerous protocols: javascript:, data:, vbscript:, etc.
  const dangerousProtocols = /^(javascript|data|vbscript|file|about|blob):/i;
  return dangerousProtocols.test(text);
}

/**
 * Sanitize and validate a message body for security.
 * Removes scripts, HTML tags, and dangerous protocols.
 *
 * @param body - The raw message body
 * @returns Sanitized body safe for storage and display
 */
export function validateAndSanitizeMessageBody(body: string): string {
  // First, sanitize HTML/script tags
  let sanitized = sanitizeMessageBody(body);

  // Check for dangerous protocols in URLs
  if (containsDangerousProtocol(sanitized)) {
    // Remove the dangerous part
    sanitized = sanitized.replace(/^(javascript|data|vbscript|file|about|blob):.*/i, "");
  }

  return sanitized;
}
