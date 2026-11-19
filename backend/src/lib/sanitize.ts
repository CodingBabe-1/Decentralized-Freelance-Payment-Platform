// SPDX-License-Identifier: MIT

/**
 * sanitize.ts
 *
 * Defence against stored XSS for free-text profile fields (`displayName`,
 * `bio`). Kept free of any `config`/Prisma import so it is unit testable.
 *
 * Contributor Notes:
 * - The output is plain text. Profiles are not an HTML or rich-text surface, so
 *   markup is removed rather than escaped; escaping would store `&lt;` and show
 *   it literally to every consumer that is not an HTML renderer.
 * - Stripping runs to a fixed point, so nested payloads such as
 *   `<scr<script>ipt>` cannot reassemble into a tag after one pass.
 * - Length limits are enforced by the caller before this runs; sanitising only
 *   ever shortens a value, so it can never push one over a limit.
 */

// Elements whose *content* is dangerous or meaningless as text, not just the tag.
const DANGEROUS_BLOCKS = /<\s*(script|style|iframe|object|embed|svg|math)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi;
// Any remaining (or unterminated) tag, including comments and doctype/CDATA.
const TAGS = /<\/?[a-z!?][^>]*>?/gi;
// Named, decimal and hex character references (`&lt;`, `&#60;`, `&#x3c;`).
// The terminating `;` is required so plain text like "AT&T" or "R&D" survives.
const ENTITIES = /&(?:#\d+|#x[\da-f]+|[a-z][a-z\d]*);/gi;
// Executable URL schemes, tolerating the whitespace/control characters browsers
// ignore inside a scheme (`java\tscript:`).
const SCRIPT_SCHEMES = /(?:j\s*a\s*v\s*a\s*s\s*c\s*r\s*i\s*p\s*t|v\s*b\s*s\s*c\s*r\s*i\s*p\s*t)\s*:/gi;
// A markdown link/image destination using a data: URI.
const MARKDOWN_DATA_URI = /(\]\(\s*)data\s*:[^)]*/gi;
// C0/C1 control characters other than tab, newline and carriage return.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;

/**
 * Remove HTML, character references and script-capable URL schemes from `input`,
 * returning plain text safe to store and to render.
 */
export function sanitizeText(input: string): string {
  let current = input.replace(CONTROL_CHARS, "");
  // Bounded as a guard: each pass strictly shortens the string or changes
  // nothing, so this always terminates well before the cap.
  for (let i = 0; i < 20; i++) {
    const next = current
      .replace(DANGEROUS_BLOCKS, "")
      .replace(TAGS, "")
      .replace(ENTITIES, "")
      .replace(SCRIPT_SCHEMES, "")
      .replace(MARKDOWN_DATA_URI, "$1")
      .replace(CONTROL_CHARS, "");
    if (next === current) break;
    current = next;
  }
  // A lone angle bracket cannot open a tag once tags are gone, but removing it
  // keeps the stored value inert even if a consumer concatenates it into HTML.
  return current.replace(/[<>]/g, "").trim();
}
