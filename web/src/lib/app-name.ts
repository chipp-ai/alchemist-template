/**
 * The app's own name in the SPA, from `<meta name="app-name">`.
 *
 * The server knows the name (`BRAND.name`, from the APP_NAME env the
 * platform sets), but the SPA had no way to read it, so the sidebar fell
 * back to a literal "App" whenever the signed-in user had no organization.
 * That is every Builder preview's dev user (Chipp bug 47).
 *
 * web/vite.config.ts writes the meta tag into index.html from APP_NAME when
 * Vite starts (the Builder preview's dev server gets APP_NAME from the
 * platform) or builds. No tag means no name, and the caller keeps its own
 * fallback.
 *
 * Zero dependencies: vite.config.ts imports `appNameMetaTag` in Node, and
 * the SPA imports `readAppName` in the browser.
 */

export const APP_NAME_META = "app-name";

function escapeHtmlAttr(input: string): string {
  return input
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** The meta tag for `name`, or "" when there is no usable name. */
export function appNameMetaTag(name: string | undefined | null): string {
  const value = (name ?? "").trim();
  return value ? `<meta name="${APP_NAME_META}" content="${escapeHtmlAttr(value)}" />` : "";
}

/** The minimal document shape `readAppName` needs (a fake in tests). */
interface MetaReader {
  querySelector(selector: string): { getAttribute(name: string): string | null } | null;
}

/** The app's name from the page, or null when the page carries none. */
export function readAppName(
  doc: MetaReader | undefined = (globalThis as { document?: MetaReader }).document,
): string | null {
  try {
    const value = doc?.querySelector(`meta[name="${APP_NAME_META}"]`)?.getAttribute("content")?.trim();
    return value ? value : null;
  } catch {
    return null;
  }
}
