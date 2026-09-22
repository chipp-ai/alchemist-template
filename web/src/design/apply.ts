/**
 * Apply a DesignConfig to the live document.
 *
 * Called once from main.ts before the app mounts (so the first painted
 * frame already has the project's tokens) and again by the /#/design page
 * on every control change (live preview).
 *
 * How it coexists with the rest of the design system:
 *   - Tokens go into ONE <style id="design-tokens"> element as a `:root`
 *     rule, not inline styles. app.css's `:root[data-theme="dark"]` block
 *     is more specific, so the user's dark-mode toggle (theme store) keeps
 *     working over a light design. A design whose `mode` is "dark" is
 *     dark by construction: its palette is emitted for BOTH themes.
 *   - The brand vars it sets (--brand-primary/-accent/-neutral,
 *     --brand-font-heading/-body, --brand-radius-scale,
 *     --brand-primary-contrast) are the same ones the platform's
 *     brand-loader.js writes, so a platform brand config still overrides
 *     at runtime when present.
 *   - `data-radius-scale` mirrors the brand v3 personality label; the
 *     concrete --radius-* values are emitted too, so both agree.
 *   - One Google Fonts <link> carries exactly the families + weights the
 *     design renders.
 */

import type { DesignConfig } from "./types.ts";
import { designToCssVars, RADIUS_SCALE_LABEL } from "./tokens.ts";
import { fontRequestsFor, googleFontsUrl, nearestWeight } from "./fonts.ts";

const STYLE_ID = "design-tokens";
const FONT_LINK_ID = "design-fonts";
const PREVIEW_LINK_PREFIX = "design-font-preview-";

let lastFontUrl: string | null = null;

/** The CSS text `applyDesign` installs. Pure; exported for tests. */
export function designStylesheet(design: DesignConfig): string {
  const vars = designToCssVars(design);
  const decls = Object.entries(vars).map(([k, v]) => `  --${k}: ${v};`).join("\n");
  let css = `:root {\n${decls}\n}\n`;
  if (design.mode === "dark") {
    // Dark by design: restate the palette under the theme selector so the
    // toggle cannot flip the canvas to app.css's generic dark values, and
    // pin the canvas itself (app.css's dark block ignores --brand-neutral).
    const darkDecls = Object.entries(vars)
      .map(([k, v]) => `  --${k}: ${k === "color-bg" ? vars["brand-neutral"] : v};`)
      .join("\n");
    css += `:root[data-theme="dark"] {\n${darkDecls}\n}\n`;
  }
  return css;
}

/** Install the design's tokens, attributes and fonts on the document. */
export function applyDesign(design: DesignConfig, root: HTMLElement = document.documentElement): void {
  let style = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
  if (!style) {
    style = document.createElement("style");
    style.id = STYLE_ID;
    document.head.appendChild(style);
  }
  const css = designStylesheet(design);
  if (style.textContent !== css) style.textContent = css;

  root.setAttribute("data-radius-scale", RADIUS_SCALE_LABEL[design.shape.radius]);
  root.setAttribute("data-design-mode", design.mode);
  root.setAttribute("data-design-preset", design.preset ?? "custom");
  ensureFonts(design);
}

/** Swap the single runtime font stylesheet when the family set changes. */
export function ensureFonts(design: DesignConfig): void {
  const url = googleFontsUrl(fontRequestsFor(design.fonts));
  if (url === lastFontUrl) return;
  lastFontUrl = url;
  let link = document.getElementById(FONT_LINK_ID) as HTMLLinkElement | null;
  if (!link) {
    link = document.createElement("link");
    link.id = FONT_LINK_ID;
    link.rel = "stylesheet";
    document.head.appendChild(link);
  }
  link.href = url;
}

/**
 * Load a specimen subset (just the glyphs in `text`) for one family so a
 * font browser can render each option in its own face at a few KB each.
 * Idempotent per family.
 */
export function loadFontSpecimen(family: string, text: string): void {
  const id = PREVIEW_LINK_PREFIX + family.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  if (document.getElementById(id)) return;
  const link = document.createElement("link");
  link.id = id;
  link.rel = "stylesheet";
  link.href = googleFontsUrl(
    [{ family, weights: [nearestWeight(family, 400), nearestWeight(family, 700)] }],
    { text: text + family + "AaBbGg0123" },
  );
  document.head.appendChild(link);
}
