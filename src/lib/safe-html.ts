/**
 * Safe HTML helpers for server-rendered pages.
 *
 * Every string a server-rendered page interpolates goes through
 * `escapeHtml`. Every `href` built from config or data goes through
 * `sanitizeHref`, which returns null for anything it does not trust. Render
 * a null href as plain text, never as a link.
 *
 * The email kinds re-export `escapeHtml` from here, so there is one copy.
 */

/** Escape a string for an HTML text node or a quoted attribute value. */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Return `href` when it is safe to put in a link, otherwise null.
 *
 * Allowed: http(s) URLs, mailto: and tel: links, `#fragment` links, and
 * same-site paths that start with a single `/`. Rejected: every other
 * scheme (javascript:, data:, vbscript:), protocol-relative `//host`
 * links, backslash tricks and control characters.
 */
export function sanitizeHref(href: string | null | undefined): string | null {
  if (typeof href !== "string") return null;
  const value = href.trim();
  if (value === "" || /[\u0000-\u001f\u007f\\]/.test(value)) return null;
  if (value.startsWith("#")) return value;
  if (value.startsWith("/")) return value.startsWith("//") ? null : value;
  if (/^mailto:[^\s]+$/i.test(value) || /^tel:[+0-9().\- ]+$/i.test(value)) return value;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? value : null;
  } catch {
    return null;
  }
}
