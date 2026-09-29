/**
 * Safe JSON for HTML. Part of the SSR kernel (`.claude/rules/ssr.md`).
 *
 * `JSON.stringify` alone is not safe inside markup:
 *   - a string value with `</script` closes a `<script>` block early;
 *   - U+2028 / U+2029 are line terminators to some script parsers;
 *   - inside a quoted attribute, the JSON's own `"` ends the attribute.
 *
 * Use `safeJsonScript` for a `<script type="application/ld+json">` body and
 * `safeJsonAttr` for a `data-props="..."` attribute. Never inline
 * `JSON.stringify` output into a page.
 *
 * Every character escaped here can only occur inside a JSON string, so the
 * result is still valid JSON and `JSON.parse` round-trips it.
 */

/** JSON safe to inline as the body of a `<script>` element. */
export function safeJsonScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003C")
    .replace(/>/g, "\\u003E")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

/** JSON safe to inline in a quoted HTML attribute value. */
export function safeJsonAttr(value: unknown): string {
  return safeJsonScript(value)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
