/**
 * brand-loader.js: the app's IDENTITY from the platform, never its look.
 *
 * The look (colors, fonts, radius, shape) lives only in
 * web/src/design/design.json, applied by web/src/design/apply.ts before
 * the app mounts. This script does not touch it. It reads the platform's
 * brand record (/brand.json) on boot and applies only what is not part of
 * the look:
 *
 *   - productName      the tab title (replaces the "Loading…" placeholder)
 *   - logoUrl / logoUrlDark
 *                      `src` of every <img data-brand-logo="light|dark">
 *   - faviconUrl       <link rel="icon">
 *   - gradient.from/to --brand-gradient-from / --brand-gradient-to for
 *                      `.brand-gradient` (design.json has no gradient yet)
 *
 * An older platform still sends colors, fonts and radius in brand.json.
 * They are ignored on purpose: before this, brand.json was applied last
 * and overrode design.json, so a look changed in code reverted on Publish.
 *
 * # Wiring
 *
 * 1. window.ALCHEMIST_PROJECT_ID is set early in <head> (index.html,
 *    baked at build time).
 * 2. window.ALCHEMIST_PLATFORM_ORIGIN optionally overrides the origin
 *    (local dev: http://localhost:8200).
 * 3. Mark logo images: <img data-brand-logo="light" alt="Logo" hidden>.
 *    The script sets `src` (and clears `hidden`) when a logo exists, so a
 *    text name can stay as the fallback until then.
 *
 * # Cache busting
 *
 * GET /brand.json sends If-None-Match on refresh (304 when unchanged), and
 * the SSE channel pushes `brand-updated` so a new logo or name shows
 * without a reload.
 */

(function () {
  "use strict";

  var HEX_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

  var DEFAULT_ORIGIN = "https://api.adaas.dev";
  var origin =
    (typeof window !== "undefined" && window.ALCHEMIST_PLATFORM_ORIGIN) ||
    DEFAULT_ORIGIN;
  var projectId =
    typeof window !== "undefined" ? window.ALCHEMIST_PROJECT_ID : null;

  // Clear the static "Loading…" placeholder whether or not brand.json
  // loads; leaving it says "loading" forever.
  if (document.title === "Loading…" || document.title === "Loading...") {
    document.title = (typeof window !== "undefined" && window.location)
      ? window.location.host
      : "";
  }

  if (!projectId) {
    console.warn(
      "[brand-loader] window.ALCHEMIST_PROJECT_ID not set; the app uses its own name and no logo",
    );
    return;
  }

  var brandUrl = origin + "/api/public/brand/" + projectId + "/brand.json";
  var eventsUrl = origin + "/api/public/brand/" + projectId + "/events";

  // The last ETag we saw, sent back on refresh so an unchanged record is a
  // cheap 304.
  var lastEtag = null;
  // The last brand applied, so a logo slot that mounts later (the sidebar
  // renders after sign-in) can be filled without another fetch.
  var lastBrand = null;

  function absolute(url) {
    return url && url.charAt(0) === "/" ? origin + url : url;
  }

  function applyFavicon(url) {
    if (typeof url !== "string" || !url) return;
    var href = absolute(url);
    var link = document.getElementById("alchemist-brand-favicon");
    if (!link) {
      link = document.createElement("link");
      link.id = "alchemist-brand-favicon";
      link.rel = "icon";
      document.head.appendChild(link);
    }
    if (link.getAttribute("href") !== href) link.setAttribute("href", href);
  }

  function applyBrand(brand) {
    if (!brand || typeof brand !== "object") return;
    lastBrand = brand;
    var root = document.documentElement;

    // Gradient pair for hero/mesh accents. Each half is validated on its
    // own; app.css falls back to the design tokens for a missing half.
    if (brand.gradient && typeof brand.gradient === "object") {
      if (typeof brand.gradient.from === "string" && HEX_RE.test(brand.gradient.from)) {
        root.style.setProperty("--brand-gradient-from", brand.gradient.from);
      }
      if (typeof brand.gradient.to === "string" && HEX_RE.test(brand.gradient.to)) {
        root.style.setProperty("--brand-gradient-to", brand.gradient.to);
      }
    }

    // Tab title. Without a productName, still clear "Loading…".
    if (typeof brand.productName === "string" && brand.productName.trim()) {
      document.title = brand.productName;
    } else if (document.title === "Loading…" || document.title === "Loading...") {
      document.title = (typeof window !== "undefined" && window.location)
        ? window.location.host
        : "";
    }

    applyFavicon(brand.faviconUrl);

    // Light vs dark logo: data-brand-mode on <html> wins, else the OS
    // preference.
    var explicitMode = root.getAttribute("data-brand-mode");
    var prefersDark =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-color-scheme: dark)").matches;
    var mode = explicitMode || (prefersDark ? "dark" : "light");

    var nodes = document.querySelectorAll("img[data-brand-logo]");
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      var want = el.getAttribute("data-brand-logo") || "light";
      var url = absolute(
        want === "dark"
          ? brand.logoUrlDark || brand.logoUrl
          : brand.logoUrl || brand.logoUrlDark,
      );
      if (url) {
        if (el.getAttribute("src") !== url) el.setAttribute("src", url);
        el.removeAttribute("hidden");
      }
      el.setAttribute("data-brand-logo-resolved", mode);
    }
  }

  function fetchBrand() {
    var headers = {};
    if (lastEtag) headers["If-None-Match"] = lastEtag;
    return fetch(brandUrl, { headers: headers, credentials: "omit" })
      .then(function (res) {
        if (res.status === 304) return null;
        if (!res.ok) {
          console.warn("[brand-loader] fetch failed:", res.status);
          return null;
        }
        var etag = res.headers && res.headers.get ? res.headers.get("ETag") : null;
        if (etag) lastEtag = etag;
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
    if (typeof EventSource !== "function") return;
    var es = new EventSource(eventsUrl);
    es.addEventListener("brand-updated", function () {
      fetchBrand();
    });
    es.onerror = function () {
      // EventSource reconnects on its own.
    };
    return es;
  }

  function init() {
    fetchBrand().then(openEventStream);
  }

  // Called by components that mount a logo slot after boot
  // (web/src/lib/brand-logo.ts).
  if (typeof window !== "undefined") {
    window.alchemistBrandReapply = function () {
      if (lastBrand) applyBrand(lastBrand);
    };
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
