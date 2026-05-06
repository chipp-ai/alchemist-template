/**
 * brand-loader.js — drop into the customer app's `web/public/`,
 * reference from `<head>` as an early <script src> with `defer`.
 *
 * Reads brand_config from the alchemist platform on boot, sets CSS
 * custom properties on `:root`, and assigns logo `<img src>` for any
 * element with `data-brand-logo="light"` or `data-brand-logo="dark"`.
 * Re-runs on `brand-updated` SSE events so live edits in the
 * platform's BrandPanel propagate without a page reload.
 *
 * # Wiring
 *
 * 1. Set window.ALCHEMIST_PROJECT_ID early in `<head>` (before this
 *    script). The agent should derive this at build time from the
 *    customer app's identifier — typically baked in via a Vite env
 *    var or a tenant-scoped runtime config endpoint.
 *
 * 2. (Optional) Set window.ALCHEMIST_PLATFORM_ORIGIN to override the
 *    default origin (https://api.adaas.dev). Useful for local dev
 *    pointing at http://localhost:8200.
 *
 * 3. Reference CSS variables in your stylesheets:
 *
 *      :root {
 *        --brand-primary: #5e6ad2;
 *        --brand-accent:  #f59e0b;
 *        --brand-neutral: #fafafa;
 *      }
 *      .button { background: var(--brand-primary); }
 *
 *    The fallbacks above are ALSO the values rendered when the
 *    platform fetch fails (network, project archived, no brand
 *    configured yet) — the customer app gracefully degrades to its
 *    template defaults.
 *
 * 4. Mark logo `<img>` tags with `data-brand-logo="light|dark"`:
 *
 *      <img data-brand-logo="light" alt="Logo">
 *
 *    The script sets `src` on the appropriate one based on the
 *    user's color-scheme preference (defaults to light).
 *
 * # Cache busting
 *
 * - GET /brand.json sends `If-None-Match: "v<previousVersion>"` on
 *   every refresh. Server returns 304 if unchanged (no body, ~no
 *   work). Cheap revalidation on every request.
 * - SSE channel pushes `brand-updated` events for instant live
 *   updates. The script bumps a version counter and triggers a
 *   re-fetch.
 * - Logo URLs are content-addressed (sha256.png) so they're
 *   safe to cache forever; the URL itself changes when the bytes do.
 */

(function () {
  "use strict";

  var DEFAULT_ORIGIN = "https://api.adaas.dev";
  var origin =
    (typeof window !== "undefined" && window.ALCHEMIST_PLATFORM_ORIGIN) ||
    DEFAULT_ORIGIN;
  var projectId =
    typeof window !== "undefined" ? window.ALCHEMIST_PROJECT_ID : null;

  if (!projectId) {
    console.warn(
      "[brand-loader] window.ALCHEMIST_PROJECT_ID not set — brand will use template defaults",
    );
    return;
  }

  var brandUrl = origin + "/api/public/brand/" + projectId + "/brand.json";
  var eventsUrl = origin + "/api/public/brand/" + projectId + "/events";

  // Track the last-applied version so we don't churn the DOM on
  // every keepalive ping or on a 304 response.
  var lastVersion = -1;

  function applyBrand(brand) {
    if (!brand || typeof brand !== "object") return;

    var root = document.documentElement;
    if (typeof brand.primaryColor === "string") {
      root.style.setProperty("--brand-primary", brand.primaryColor);
    }
    if (typeof brand.accentColor === "string") {
      root.style.setProperty("--brand-accent", brand.accentColor);
    }
    if (typeof brand.neutralColor === "string") {
      root.style.setProperty("--brand-neutral", brand.neutralColor);
    }

    // Pick light vs dark logo based on the user's prefers-color-scheme.
    // The customer app can override by adding `data-brand-mode` on
    // the html element ("light" or "dark") — useful for theme
    // switchers that don't follow OS preference.
    var explicitMode = root.getAttribute("data-brand-mode");
    var prefersDark =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-color-scheme: dark)").matches;
    var mode = explicitMode || (prefersDark ? "dark" : "light");

    var nodes = document.querySelectorAll("img[data-brand-logo]");
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      var want = el.getAttribute("data-brand-logo") || "light";
      // Match the requested side, or fall back to whichever is set.
      var url =
        want === "dark"
          ? brand.logoUrlDark || brand.logoUrl
          : brand.logoUrl || brand.logoUrlDark;
      // Resolve relative URLs against the platform origin so customer
      // apps can use the proxy without rewriting the URL.
      if (url && url.charAt(0) === "/") url = origin + url;
      if (url && el.src !== url) el.src = url;
      // Mirror mode for any CSS that wants to know the resolved side.
      el.setAttribute("data-brand-logo-resolved", mode);
    }

    if (typeof brand.version === "number") {
      lastVersion = brand.version;
    }
  }

  function fetchBrand() {
    var headers = {};
    if (lastVersion >= 0) {
      headers["If-None-Match"] = '"v' + lastVersion + '"';
    }
    return fetch(brandUrl, { headers: headers, credentials: "omit" })
      .then(function (res) {
        if (res.status === 304) return null; // unchanged
        if (!res.ok) {
          console.warn("[brand-loader] fetch failed:", res.status);
          return null;
        }
        return res.json();
      })
      .then(function (brand) {
        if (brand) applyBrand(brand);
      })
      .catch(function (err) {
        console.warn("[brand-loader] fetch error:", err);
      });
  }

  function openEventStream() {
    if (typeof EventSource !== "function") return; // older browsers — skip live updates, polling-on-fetch is the fallback

    var es = new EventSource(eventsUrl);
    es.addEventListener("hello", function (evt) {
      try {
        var data = JSON.parse(evt.data);
        // If the server's version is ahead of what we have, fetch.
        if (typeof data.version === "number" && data.version !== lastVersion) {
          fetchBrand();
        }
      } catch (_) {
        // ignore
      }
    });
    es.addEventListener("brand-updated", function () {
      fetchBrand();
    });
    es.onerror = function () {
      // EventSource auto-reconnects; nothing to do but log.
      // (Don't close — the browser handles backoff for us.)
    };

    return es;
  }

  function init() {
    // Initial fetch first — apply current brand before opening the
    // event stream (so the `hello` event sees lastVersion populated).
    fetchBrand().then(openEventStream);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
