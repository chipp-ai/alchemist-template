/**
 * Chipp Insights beacon injection.
 *
 * Injects a single `<script>` tag referencing the first-party Chipp
 * Insights beacon (https://build.chipp.ai/i/beacon.js) right before
 * `</head>` on every HTML response -- but ONLY when
 * `src/lib/chipp-insights.ts` found a valid `telemetryPublicKey` in
 * `chipp-insights.json` at the repo root.
 *
 * Complete no-op (calls `next()` and returns without inspecting or
 * mutating the response at all) when no config was found -- see
 * `src/lib/chipp-insights.ts` for the fail-open contract. Most template
 * checkouts have no such file, and that must never break page rendering.
 *
 * The beacon primarily reports via `navigator.sendBeacon`, so no
 * `Content-Security-Policy` allowance is needed for it in this template
 * (none is configured -- see `app.ts`'s bare `secureHeaders()` call). If a
 * future customization adds a CSP, allow `https://build.chipp.ai` in both
 * `script-src` (loading the tag) and `connect-src` (any `fetch` fallback).
 *
 * Registered in `app.ts` AFTER `compress()` / `secureHeaders()` / `timing()`
 * so the body it rewrites is still uncompressed at this point, and any
 * later compression sees the final, beacon-injected body -- same ordering
 * rationale as `demo-banner.ts`.
 */

import { createMiddleware } from "hono/factory";
import { CHIPP_INSIGHTS_CONFIG, type ChippInsightsConfig } from "@/lib/chipp-insights.ts";

const HEAD_CLOSE_RE = /<\/head>/i;

function escapeHtmlAttr(input: string): string {
  return input
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/**
 * `telemetryPublicKey` is a platform-minted `tk_pub_`-prefixed hex string,
 * so real attack input isn't expected here -- but the value still flows
 * into an HTML attribute, so it's escaped as a matter of course.
 */
function beaconTag(config: ChippInsightsConfig): string {
  return `<script src="https://build.chipp.ai/i/beacon.js" data-project-key="${
    escapeHtmlAttr(config.telemetryPublicKey)
  }" async></script>`;
}

/**
 * Factory so tests can inject a config directly instead of writing a real
 * `chipp-insights.json` to disk. `chippInsightsMiddleware` below (built
 * with no args) is the instance actually mounted in `app.ts`.
 */
export function createChippInsightsMiddleware(
  config: ChippInsightsConfig | null = CHIPP_INSIGHTS_CONFIG,
) {
  return createMiddleware(async (c, next) => {
    await next();
    if (!config) return;

    const contentType = c.res.headers.get("Content-Type") ?? "";
    if (!contentType.includes("text/html")) return;

    // Reading .text() drains the original Response body. From this point on
    // we MUST rebuild c.res on every path (even the "nothing to inject"
    // early return below) -- returning without reassigning would hand the
    // caller a Response whose body stream was already consumed.
    const original = await c.res.text();
    const headers = new Headers(c.res.headers);

    if (!HEAD_CLOSE_RE.test(original)) {
      // Not a full HTML document -- nothing safe to inject into. Content is
      // byte-for-byte unchanged, so the original Content-Length still holds.
      c.res = new Response(original, { status: c.res.status, headers });
      return;
    }

    const injected = original.replace(HEAD_CLOSE_RE, `${beaconTag(config)}\n</head>`);
    headers.delete("Content-Length");
    c.res = new Response(injected, { status: c.res.status, headers });
  });
}

/** The production middleware instance, mounted unconditionally in `app.ts`. */
export const chippInsightsMiddleware = createChippInsightsMiddleware();
