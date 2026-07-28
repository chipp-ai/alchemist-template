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
 *
 * # v3 fields (all OPTIONAL / nullable — brand.json may omit any of them)
 *
 * - `fontHeading` / `fontBody` (string): a Google Fonts family name.
 *   Sets `--brand-font-heading` / `--brand-font-body` (quoted, ready to
 *   drop into a font-family list) AND injects the matching Google Fonts
 *   <link> (see ensureGoogleFontsLink below — "the fonts partial").
 * - `radiusScale` ("sharp" | "soft" | "round"): sets `--brand-radius-scale`
 *   plus a `data-radius-scale` attribute on <html> — app.css keys its
 *   concrete `--radius-*` px sets off that attribute.
 * - `gradient.from` / `gradient.to` (hex): sets `--brand-gradient-from` /
 *   `--brand-gradient-to` for hero/mesh accent surfaces (`.brand-gradient`
 *   in app.css).
 *
 * Every v3 field degrades gracefully when absent — app.css's `var(--brand-x,
 * <fallback>)` reads render the identical template-default design.
 */

(function () {
  "use strict";

  var HEX_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

  // Shared WCAG relative-luminance formula (sRGB), 0 (black) to 1 (white).
  // Both isLightSurface() and contrastTextFor() below key off this so the
  // math lives in exactly one place in this file.
  function relativeLuminanceHex(hex) {
    var m = HEX_RE.exec(hex);
    if (!m) return null;
    var h = m[1];
    if (h.length === 3) h = h.charAt(0) + h.charAt(0) + h.charAt(1) + h.charAt(1) + h.charAt(2) + h.charAt(2);
    function lin(c) { c = c / 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
    return 0.2126 * lin(parseInt(h.slice(0, 2), 16)) +
      0.7152 * lin(parseInt(h.slice(2, 4), 16)) +
      0.0722 * lin(parseInt(h.slice(4, 6), 16));
  }

  // True when a #RGB/#RRGGBB hex is light enough to serve as a page/input
  // background in the light-mode template designs (relative luminance).
  function isLightSurface(hex) {
    var lum = relativeLuminanceHex(hex);
    return lum !== null && lum >= 0.55;
  }

  // WCAG contrast ratio between a hex color and pure white/black — used to
  // pick whichever of the two reads AA (>=4.5:1) as TEXT on `hex` as a
  // background (e.g. label text on a solid --brand-primary button). CSS
  // cannot branch on luminance itself (the `contrast-color()` proposal
  // isn't shipping yet), so this has to run in JS. Mirrors — and is unit-
  // tested via — web/src/lib/color-math.ts's pickContrastText(); this copy
  // is duplicated (not imported) because brand-loader.js is served
  // unbundled to <head> and can't `import` from the Vite-built web/src
  // tree.
  function contrastTextFor(hex) {
    var lum = relativeLuminanceHex(hex);
    if (lum === null) return null;
    var inkLum = relativeLuminanceHex("#111827"); // --color-text ink token
    var whiteRatio = 1.05 / (lum + 0.05); // white luminance is always 1
    var lighter = Math.max(lum, inkLum);
    var darker = Math.min(lum, inkLum);
    var inkRatio = (lighter + 0.05) / (darker + 0.05);
    return whiteRatio >= inkRatio ? "#ffffff" : "#111827";
  }

  var GOOGLE_FONTS_LINK_ID = "alchemist-brand-fonts";
  var RADIUS_SCALES = ["sharp", "soft", "round"];

  // Google Fonts CSS2 API wants spaces in a family name encoded as "+".
  function googleFontsFamilyParam(name) {
    return encodeURIComponent(name).replace(/%20/g, "+");
  }

  // The "fonts partial": builds a Google Fonts <link> request from the
  // brand's chosen heading/body families (v3, nullable) with
  // display=swap so text never sits invisible waiting on the download —
  // it renders on the system-stack fallback (see app.css --font-heading /
  // --font-sans) until the real font swaps in. No-ops when neither family
  // is set (every project before v3 data exists): index.html's static
  // Inter/JetBrains Mono <link> already covers that case.
  function ensureGoogleFontsLink(headingFamily, bodyFamily) {
    var families = [];
    if (typeof headingFamily === "string" && headingFamily.trim()) {
      families.push(headingFamily.trim());
    }
    if (
      typeof bodyFamily === "string" && bodyFamily.trim() &&
      families.indexOf(bodyFamily.trim()) === -1
    ) {
      families.push(bodyFamily.trim());
    }
    if (families.length === 0) return;

    var params = families
      .map(function (f) {
        return "family=" + googleFontsFamilyParam(f) + ":ital,wght@0,400;0,500;0,600;0,700;1,400";
      })
      .join("&");
    var href = "https://fonts.googleapis.com/css2?" + params + "&display=swap";

    var existing = document.getElementById(GOOGLE_FONTS_LINK_ID);
    if (existing && existing.getAttribute("href") === href) return; // already applied

    var link = document.createElement("link");
    link.id = GOOGLE_FONTS_LINK_ID;
    link.rel = "stylesheet";
    link.href = href;
    document.head.appendChild(link);
    if (existing) existing.parentNode.removeChild(existing);
  }

  var DEFAULT_ORIGIN = "https://api.adaas.dev";
  var origin =
    (typeof window !== "undefined" && window.ALCHEMIST_PLATFORM_ORIGIN) ||
    DEFAULT_ORIGIN;
  var projectId =
    typeof window !== "undefined" ? window.ALCHEMIST_PROJECT_ID : null;

  // Clear the static "Loading…" placeholder regardless of whether
  // we can fetch /brand.json. Letting it persist is the documented
  // failure mode where customers say "the tab title says Loading
  // forever". The host fallback matches what browsers show
  // natively when <title> is empty.
  if (document.title === "Loading…" || document.title === "Loading...") {
    document.title = (typeof window !== "undefined" && window.location)
      ? window.location.host
      : "";
  }

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
    if (typeof brand.neutralColor === "string" && isLightSurface(brand.neutralColor)) {
      // Luminance guard: --brand-neutral feeds page/card/input BACKGROUNDS
      // in the light-mode templates, so a dark generated neutral must NOT
      // apply (it renders half-dark UI, e.g. black inputs on a light page;
      // 2026-07-28 demo bug). Dark values fall back to the CSS default.
      root.style.setProperty("--brand-neutral", brand.neutralColor);
    }

    // Contrast-safe text color for the primary accent surface (buttons,
    // badges, ...). Recomputed whenever primaryColor is present so it
    // always tracks the live brand color, never a stale/default value.
    if (typeof brand.primaryColor === "string") {
      var contrast = contrastTextFor(brand.primaryColor);
      if (contrast) root.style.setProperty("--brand-primary-contrast", contrast);
    }

    // v3 (nullable): typography. Quoted so the value drops straight into
    // a font-family list (`var(--brand-font-heading, "Inter")`). Absent/
    // blank → the CSS var stays unset and app.css's fallback holds.
    if (typeof brand.fontHeading === "string" && brand.fontHeading.trim()) {
      root.style.setProperty("--brand-font-heading", '"' + brand.fontHeading.trim() + '"');
    }
    if (typeof brand.fontBody === "string" && brand.fontBody.trim()) {
      root.style.setProperty("--brand-font-body", '"' + brand.fontBody.trim() + '"');
    }
    ensureGoogleFontsLink(brand.fontHeading, brand.fontBody);

    // v3 (nullable): radius personality. The concrete px sets live in
    // app.css's [data-radius-scale="..."] overrides — CSS can't switch a
    // numeric value off an arbitrary custom-property string without a
    // selector to key on, so the value is mirrored onto both the CSS var
    // (for any code that wants the raw label) and the data attribute.
    if (typeof brand.radiusScale === "string" && RADIUS_SCALES.indexOf(brand.radiusScale) !== -1) {
      root.style.setProperty("--brand-radius-scale", brand.radiusScale);
      root.setAttribute("data-radius-scale", brand.radiusScale);
    }

    // v3 (nullable): gradient pair for hero/mesh accents. Each half is
    // hex-validated independently so a half-valid pair still lets
    // whichever half validated apply — app.css's .brand-gradient falls
    // back to --brand-primary/--brand-accent for the other half.
    if (brand.gradient && typeof brand.gradient === "object") {
      if (typeof brand.gradient.from === "string" && HEX_RE.test(brand.gradient.from)) {
        root.style.setProperty("--brand-gradient-from", brand.gradient.from);
      }
      if (typeof brand.gradient.to === "string" && HEX_RE.test(brand.gradient.to)) {
        root.style.setProperty("--brand-gradient-to", brand.gradient.to);
      }
    }

    // Set the document title. The HTML's static <title> is a
    // "Loading…" placeholder — we replace it once brand.json
    // resolves so the real product name appears in the tab.
    //
    // Important: even when brand.productName is MISSING (brand
    // config never populated, or only colors saved), we still
    // need to clear "Loading…" — leaving it lies about an ongoing
    // load state and breaks browser history / OS window switchers.
    // The fallback uses the URL's hostname (e.g. "localhost:5273")
    // which is what browsers show natively when <title> is empty.
    // Customer code that wants a different fallback can set
    // document.title from its own boot path (PublicShell.svelte etc.).
    if (typeof brand.productName === "string" && brand.productName.trim()) {
      document.title = brand.productName;
    } else if (document.title === "Loading…" || document.title === "Loading...") {
      document.title = (typeof window !== "undefined" && window.location)
        ? window.location.host
        : "";
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
