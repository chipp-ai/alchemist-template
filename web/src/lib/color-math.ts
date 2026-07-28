/**
 * Pure color-derivation math shared by the design-token system.
 *
 * CSS `color-mix()` handles every blend-only derivation (hover/active/
 * subtle/soft tints) directly in web/src/app.css — no JS involved
 * there. The ONE thing CSS cannot do (the `contrast-color()` proposal
 * is not yet broadly supported by shipping browsers) is pick BETWEEN
 * two fixed text colors based on a background's relative luminance.
 * That branch has to happen in JS, so `web/public/brand-loader.js`
 * calls its own (duplicated, see the comment above `contrastTextFor`
 * there) copy of this math to compute `--brand-primary-contrast`
 * whenever a project's brand palette loads.
 *
 * This module is DOM-free and framework-free ON PURPOSE: it has to be
 * importable from a plain Deno test (no browser globals available) so
 * the WCAG formulas themselves are verified — see
 * src/__tests__/design-tokens.test.ts — not just eyeballed in a
 * browser.
 */

const HEX_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/** Normalizes `#abc` / `#AABBCC` to a lowercase `#aabbcc`. Throws on invalid input. */
export function normalizeHex(hex: string): string {
  const m = HEX_RE.exec(hex.trim());
  if (!m) {
    throw new Error(`Not a valid #hex color: ${hex}`);
  }
  let h = m[1];
  if (h.length === 3) {
    h = h.split("").map((c) => c + c).join("");
  }
  return `#${h.toLowerCase()}`;
}

/** True when `hex` is a syntactically valid `#RGB` / `#RRGGBB` color. */
export function isValidHex(hex: string): boolean {
  return HEX_RE.test(hex.trim());
}

export function hexToRgb(hex: string): [number, number, number] {
  const h = normalizeHex(hex).slice(1);
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

/** WCAG 2.x relative luminance (sRGB color space), 0 (black) to 1 (white). */
export function relativeLuminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map((c) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two colors: 1 (identical) to 21 (black/white). */
export function contrastRatio(hexA: string, hexB: string): number {
  const lA = relativeLuminance(hexA);
  const lB = relativeLuminance(hexB);
  const lighter = Math.max(lA, lB);
  const darker = Math.min(lA, lB);
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * True when `hex` is light enough to serve as a page/card/input
 * BACKGROUND in this template's light-mode design (mirrors the
 * neutral-color guard in brand-loader.js's isLightSurface).
 */
export function isLightSurface(hex: string, threshold = 0.55): boolean {
  return relativeLuminance(hex) >= threshold;
}

const WHITE = "#ffffff";
const INK = "#111827"; // the --color-text ink token, not a hand-picked UI hex
export const AA_NORMAL_TEXT_RATIO = 4.5;

export interface ContrastTextResult {
  /** Whichever of white / ink reads best on the given background. */
  color: string;
  /** The WCAG contrast ratio actually achieved. */
  ratio: number;
  /** True when `ratio` clears the WCAG AA threshold for normal text (4.5:1). */
  passesAA: boolean;
}

/**
 * Picks whichever of white / ink text reads AA (>=4.5:1) on `bgHex`.
 * When neither choice clears 4.5:1 (an extreme mid-tone brand color),
 * returns the one with the HIGHER ratio — always the best available
 * option rather than silently failing.
 */
export function pickContrastText(bgHex: string): ContrastTextResult {
  const whiteRatio = contrastRatio(bgHex, WHITE);
  const inkRatio = contrastRatio(bgHex, INK);
  const useWhite = whiteRatio >= inkRatio;
  const ratio = useWhite ? whiteRatio : inkRatio;
  return {
    color: useWhite ? WHITE : INK,
    ratio,
    passesAA: ratio >= AA_NORMAL_TEXT_RATIO,
  };
}
