/**
 * Demo-mode banner: server-rendered, session-dismissable, no JS required.
 *
 * Part of the shared DEMO_MODE contract (see docs/demo-mode.md). When
 * `DEMO_MODE=1`, every HTML response gets a banner injected right after
 * the opening `<body>` tag announcing that this is a fictional live demo.
 * The banner text is emitted directly in the server-rendered markup --
 * nothing builds it client-side -- so it is visible even with JavaScript
 * disabled, satisfying the "no JS required to display" requirement.
 *
 * Dismissal is a plain `<a>` link to `GET /demo/dismiss-banner`, which
 * sets a SESSION cookie (no `maxAge`/`expires`, so it disappears when the
 * browser closes -- "session-dismissable") and redirects back to the page
 * the visitor was on. No JS is required for dismissal either; the whole
 * interaction is two ordinary HTTP requests. If cookies are disabled the
 * banner simply reappears on the next page -- a graceful degrade, never a
 * hard failure.
 *
 * Complete no-op when DEMO_MODE is off: the middleware calls `next()` and
 * returns without inspecting or mutating the response at all, and the
 * dismiss route falls through to whatever would have handled that path
 * before it existed (same pattern as `demo-noindex.ts`'s robots.txt route).
 */

import { createMiddleware } from "hono/factory";
import { getCookie, setCookie } from "hono/cookie";
import { isDemoMode } from "@/config/demo-mode.ts";

export const DEMO_BANNER_DISMISS_COOKIE = "demo_banner_dismissed";
export const DEMO_BANNER_DISMISS_PATH = "/demo/dismiss-banner";

/**
 * Human label for the template shown in the banner copy. Deliberately a
 * plain constant (not read from `BRAND`) -- the banner is describing the
 * ALCHEMIST TEMPLATE itself to a prospective builder, not the customer
 * product `BRAND` represents; those are two different audiences and a
 * live demo pod has no real customer brand configured anyway.
 */
const TEMPLATE_LABEL = "SaaS Starter";

const IS_PROD = Deno.env.get("NODE_ENV") === "production";

function escapeHtml(input: string): string {
  return input
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** Builds the banner markup. `redirectTo` is escaped -- it flows into an href attribute. */
function bannerHtml(redirectTo: string): string {
  const label = escapeHtml(TEMPLATE_LABEL);
  const dismissHref = `${DEMO_BANNER_DISMISS_PATH}?to=${encodeURIComponent(redirectTo)}`;
  return (
    `<div id="alchemist-demo-banner" role="banner" ` +
    `style="position:sticky;top:0;left:0;right:0;z-index:2147483647;display:flex;` +
    `align-items:center;justify-content:center;gap:1rem;flex-wrap:wrap;` +
    `background:#111827;color:#f9fafb;padding:0.6rem 1rem;` +
    `font:14px/1.4 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;text-align:center;">` +
    `<span>Live demo of the ${label} template on Alchemist &mdash; all content is fictional.</span>` +
    `<a href="${escapeHtml(dismissHref)}" ` +
    `style="color:#f9fafb;text-decoration:underline;flex-shrink:0;">Dismiss</a>` +
    `</div>`
  );
}

/** Restricts a redirect target to a same-origin relative path -- never an open redirect. */
function safeRedirectPath(raw: string | undefined): string {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//")) return "/";
  return raw;
}

/**
 * Injects the demo banner into every HTML response, unless the visitor
 * already dismissed it this session. Must be registered so it wraps the
 * static SPA + any other HTML-emitting route (order relative to
 * `compress()` matters -- see docs/demo-mode.md).
 */
export const demoBannerMiddleware = createMiddleware(async (c, next) => {
  await next();
  if (!isDemoMode()) return;
  if (getCookie(c, DEMO_BANNER_DISMISS_COOKIE) === "1") return;

  const contentType = c.res.headers.get("Content-Type") ?? "";
  if (!contentType.includes("text/html")) return;

  const original = await c.res.text();
  const bodyTagMatch = original.match(/<body[^>]*>/i);
  if (!bodyTagMatch) return; // not a full HTML document -- nothing safe to inject into

  const redirectTo = c.req.path + (new URL(c.req.url).search ?? "");
  const injected = original.replace(
    bodyTagMatch[0],
    `${bodyTagMatch[0]}\n${bannerHtml(redirectTo)}`,
  );

  const headers = new Headers(c.res.headers);
  headers.delete("Content-Length");
  c.res = new Response(injected, { status: c.res.status, headers });
});

/**
 * `GET /demo/dismiss-banner?to=<path>` -- sets the session-scoped dismiss
 * cookie and redirects back to `to` (validated same-origin-relative).
 * Falls through to `next()` when DEMO_MODE is off, so this path behaves
 * exactly as it would have if this route never existed (404, most likely).
 */
export const demoBannerDismissRoute = createMiddleware(async (c, next) => {
  if (!isDemoMode()) return next();

  setCookie(c, DEMO_BANNER_DISMISS_COOKIE, "1", {
    httpOnly: true,
    secure: IS_PROD,
    sameSite: "Lax",
    path: "/",
    // No maxAge/expires -- a browser SESSION cookie, cleared when the
    // browser closes. That's the "session-dismissable" contract.
  });

  return c.redirect(safeRedirectPath(c.req.query("to")), 302);
});
