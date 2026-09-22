/**
 * Design config → CSS custom properties, plus the colour math the
 * validator and the design page share.
 *
 * Pure functions, no DOM, no dependencies. Imported by the SPA (apply.ts,
 * Design.svelte), the Deno API (design.service.ts) and the tests.
 *
 * Derivation rules (the "why" behind each token):
 *   - 60/30/10: background dominates, surface + text carry structure, the
 *     primary is reserved for action. Accent is rarer still.
 *   - Text tiers are mixes of ink toward the canvas, so they stay legible
 *     on ANY background the builder picks (no fixed greys).
 *   - Borders are ink at low opacity for the same reason.
 *   - Button label colour is chosen by contrast, not assumed white.
 *   - Radius is one family of values, never mixed; pill applies only to
 *     controls, cards keep a large-but-finite radius.
 *   - Type sizes come from one modular scale off the base size.
 */

import type {
  Density,
  DesignConfig,
  DesignMode,
  RadiusPreset,
  ShadowPreset,
} from "./types.ts";
import { FALLBACK_STACKS, fontCategory } from "./fonts.ts";

/**
 * The platform's brand v3 radius personality (`brand-loader.js` sets
 * `data-radius-scale` from brand.json). A design's finer radius preset maps
 * onto it so upstream `[data-radius-scale]` rules and any component keyed on
 * the label agree with the concrete --radius-* values we also emit.
 */
export const RADIUS_SCALE_LABEL: Record<RadiusPreset, "sharp" | "soft" | "round"> = {
  none: "sharp",
  sm: "sharp",
  md: "soft",
  lg: "round",
  pill: "round",
};

// ── Colour math ─────────────────────────────────────────────────────────

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

export function hexToRgb(hex: string): Rgb | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  let h = m[1];
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const n = parseInt(h, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

export function rgbToHex({ r, g, b }: Rgb): string {
  const c = (v: number) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0");
  return `#${c(r)}${c(g)}${c(b)}`;
}

export function isHexColor(value: string): boolean {
  return hexToRgb(value) !== null;
}

/** Normalize to lowercase 6-digit `#rrggbb`. */
export function normalizeHex(value: string): string {
  const rgb = hexToRgb(value);
  return rgb ? rgbToHex(rgb) : value;
}

/** Mix `a` toward `b` by `t` (0 = a, 1 = b), in sRGB. */
export function mix(a: string, b: string, t: number): string {
  const A = hexToRgb(a);
  const B = hexToRgb(b);
  if (!A || !B) return a;
  const k = Math.max(0, Math.min(1, t));
  return rgbToHex({
    r: A.r + (B.r - A.r) * k,
    g: A.g + (B.g - A.g) * k,
    b: A.b + (B.b - A.b) * k,
  });
}

/** WCAG relative luminance, 0 (black) to 1 (white). */
export function luminance(hex: string): number {
  const rgb = hexToRgb(hex);
  if (!rgb) return 0;
  const lin = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin(rgb.r) + 0.7152 * lin(rgb.g) + 0.0722 * lin(rgb.b);
}

/** WCAG contrast ratio, 1 to 21. */
export function contrastRatio(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** Whichever of near-white / near-black reads better on `bg`. */
export function bestTextOn(bg: string): string {
  return contrastRatio(bg, "#ffffff") >= contrastRatio(bg, "#111111") ? "#ffffff" : "#111111";
}

/**
 * The lightest tint of `ink` over `bg` that still reaches `minRatio`,
 * searching from `start` toward full ink in 2% steps. Used for muted text
 * so captions clear WCAG AA on any canvas instead of trusting one ratio.
 */
export function tintForContrast(bg: string, ink: string, minRatio: number, start = 0.5): string {
  for (let t = start; t <= 1; t += 0.02) {
    const c = mix(bg, ink, t);
    if (contrastRatio(c, bg) >= minRatio) return c;
  }
  return ink;
}

// ── Scales ──────────────────────────────────────────────────────────────

export interface RadiusValues {
  sm: string;
  md: string;
  lg: string;
  /** Buttons, inputs, badges. */
  control: string;
}

export const RADIUS_VALUES: Record<RadiusPreset, RadiusValues> = {
  none: { sm: "0px", md: "0px", lg: "0px", control: "0px" },
  sm: { sm: "3px", md: "4px", lg: "6px", control: "4px" },
  md: { sm: "6px", md: "8px", lg: "12px", control: "8px" },
  lg: { sm: "10px", md: "14px", lg: "20px", control: "12px" },
  pill: { sm: "8px", md: "12px", lg: "18px", control: "9999px" },
};

export const DENSITY_FACTOR: Record<Density, number> = {
  compact: 0.85,
  comfortable: 1,
  spacious: 1.2,
};

const SPACE_BASE = { xs: 4, sm: 8, md: 16, lg: 24, xl: 32, "2xl": 48 } as const;

export function spaceScale(density: Density): Record<keyof typeof SPACE_BASE, string> {
  const f = DENSITY_FACTOR[density];
  const out = {} as Record<keyof typeof SPACE_BASE, string>;
  for (const [k, v] of Object.entries(SPACE_BASE) as [keyof typeof SPACE_BASE, number][]) {
    out[k] = `${Math.round(v * f)}px`;
  }
  return out;
}

export const TYPE_STEPS = ["xs", "sm", "base", "lg", "xl", "2xl", "3xl", "4xl"] as const;
export type TypeStep = typeof TYPE_STEPS[number];

/** Modular scale in rem relative to the base size (base = 1rem). */
export function typeScale(ratio: number): Record<TypeStep, string> {
  const exp: Record<TypeStep, number> = { xs: -2, sm: -1, base: 0, lg: 1, xl: 2, "2xl": 3, "3xl": 4, "4xl": 5 };
  const out = {} as Record<TypeStep, string>;
  for (const step of TYPE_STEPS) {
    out[step] = `${(Math.pow(ratio, exp[step])).toFixed(3).replace(/\.?0+$/, "")}rem`;
  }
  return out;
}

export function shadowValues(preset: ShadowPreset, ink: string): { sm: string; md: string; lg: string } {
  switch (preset) {
    case "none":
      return { sm: "none", md: "none", lg: "none" };
    case "hard": {
      return {
        sm: `2px 2px 0 ${ink}`,
        md: `4px 4px 0 ${ink}`,
        lg: `6px 6px 0 ${ink}`,
      };
    }
    case "soft":
    default:
      return {
        sm: "0 1px 2px rgba(0, 0, 0, 0.05)",
        md: "0 4px 6px -1px rgba(0, 0, 0, 0.07), 0 2px 4px -2px rgba(0, 0, 0, 0.05)",
        lg: "0 12px 24px -8px rgba(0, 0, 0, 0.16), 0 4px 8px -4px rgba(0, 0, 0, 0.08)",
      };
  }
}

const SEMANTIC_DEFAULTS: Record<DesignMode, { success: string; warning: string; danger: string }> = {
  light: { success: "#15803d", warning: "#b45309", danger: "#b91c1c" },
  dark: { success: "#4ade80", warning: "#fbbf24", danger: "#f87171" },
};

// ── Tokens ──────────────────────────────────────────────────────────────

/**
 * Every CSS custom property the stylesheet reads, derived from one design.
 * Keys omit the leading `--`. Values are plain CSS strings.
 *
 * `--brand-*` are set too: the platform's brand-loader.js overrides those
 * at runtime when a project has a brand config, and the derived accent
 * tokens reference them through var() so a platform-side colour change
 * still flows through without touching this file.
 */
export function designToCssVars(design: DesignConfig): Record<string, string> {
  const { colors, mode } = design;
  const bg = normalizeHex(colors.background);
  const surface = normalizeHex(colors.surface);
  const text = normalizeHex(colors.text);
  const primary = normalizeHex(colors.primary);
  const accent = normalizeHex(colors.accent);
  const isDark = mode === "dark";
  const towardRaised = isDark ? "#ffffff" : "#ffffff";
  const sem = SEMANTIC_DEFAULTS[mode];
  const success = normalizeHex(colors.success ?? sem.success);
  const warning = normalizeHex(colors.warning ?? sem.warning);
  const danger = normalizeHex(colors.danger ?? sem.danger);
  const radius = RADIUS_VALUES[design.shape.radius];
  const shadows = shadowValues(design.shape.shadow, text);
  const space = spaceScale(design.density);
  const type = typeScale(design.type.scale);

  const quote = (family: string) => `"${family.trim()}"`;
  const stackFor = (brandVar: string, family: string) =>
    `var(${brandVar}, ${quote(family)}), ${FALLBACK_STACKS[fontCategory(family)]}`;

  const vars: Record<string, string> = {
    // ── Brand seam ──
    // These are the SAME custom properties the platform's brand-loader.js
    // sets from brand.json (v2 colours, v3 fonts/radius/contrast). design.json
    // is the repo-side source; a platform brand config, when present, can
    // still override them at runtime. Every derived token below reaches the
    // brand through var(), so either writer wins consistently.
    "brand-primary": primary,
    "brand-accent": accent,
    "brand-neutral": bg,
    "brand-primary-contrast": bestTextOn(primary),
    "brand-font-heading": quote(design.fonts.heading),
    "brand-font-body": quote(design.fonts.body),
    "brand-radius-scale": RADIUS_SCALE_LABEL[design.shape.radius],

    // Canvas + surfaces. `color-bg` stays a var() so the dark theme block in
    // app.css (which sets a fixed dark canvas) keeps winning under the toggle.
    "color-bg": "var(--brand-neutral)",
    "color-surface": surface,
    "color-surface-raised": mix(surface, towardRaised, isDark ? 0.06 : 0.5),
    "color-surface-sunken": mix(bg, text, isDark ? 0.06 : 0.04),

    // Borders: ink at low opacity so they track any canvas.
    "color-border": mix(bg, text, isDark ? 0.16 : 0.13),
    "color-border-strong": mix(bg, text, isDark ? 0.28 : 0.24),

    // Text tiers. Muted is the lightest ink tint that still clears 4.6:1
    // (captions are body-size text under WCAG); secondary sits a step darker.
    "color-text": text,
    "color-text-secondary": tintForContrast(bg, text, 7, 0.7),
    "color-muted": tintForContrast(bg, text, 4.6, 0.5),

    // Action colour (hover/active/subtle/contrast come from app.css's
    // color-mix ramp off --brand-primary; only the soft wash is restated so
    // it mixes toward THIS design's canvas).
    "color-accent-soft": `color-mix(in srgb, var(--brand-primary) ${isDark ? "22%" : "12%"}, var(--color-bg))`,
    "color-focus-ring": `color-mix(in srgb, var(--brand-primary) 55%, transparent)`,

    // Highlight (second brand hue)
    "color-highlight": "var(--brand-accent)",
    "color-highlight-soft": `color-mix(in srgb, var(--brand-accent) ${isDark ? "24%" : "14%"}, var(--color-bg))`,
    "color-highlight-contrast": bestTextOn(accent),

    // Semantic base hues (their -bg/-hover/-border ramps derive in app.css).
    "color-success": success,
    "color-warning": warning,
    "color-error": danger,

    // Fonts. The heading/body stacks route through the brand vars set just
    // above, with a fallback stack matched to the family's construction.
    "font-heading": stackFor("--brand-font-heading", design.fonts.heading),
    "font-sans": stackFor("--brand-font-body", design.fonts.body),
    "font-mono": `${quote(design.fonts.mono)}, ${FALLBACK_STACKS.mono}`,
    "font-heading-weight": String(design.fonts.headingWeight),
    "font-body-weight": String(design.fonts.bodyWeight),
    "heading-tracking": `${design.type.headingTracking}em`,
    "heading-case": design.type.headingCase === "upper" ? "uppercase" : "none",

    // Type scale
    "text-root-size": `${design.type.baseSize}px`,
    "text-xs": type.xs,
    "text-sm": type.sm,
    "text-base": type.base,
    "text-lg": type.lg,
    "text-xl": type.xl,
    "text-2xl": type["2xl"],
    "text-3xl": type["3xl"],
    "text-4xl": type["4xl"],

    // Spacing
    "space-xs": space.xs,
    "space-sm": space.sm,
    "space-md": space.md,
    "space-lg": space.lg,
    "space-xl": space.xl,
    "space-2xl": space["2xl"],

    // Shape
    "radius-sm": radius.sm,
    "radius-md": radius.md,
    "radius-lg": radius.lg,
    "radius-control": radius.control,
    "radius-full": "9999px",
    "border-width": `${design.shape.borderWidth}px`,
    "shadow-sm": shadows.sm,
    "shadow-md": shadows.md,
    "shadow-lg": shadows.lg,

    "color-scheme": mode,
  };
  return vars;
}

// ── Validation ──────────────────────────────────────────────────────────

export type IssueLevel = "error" | "warn";

export interface DesignIssue {
  level: IssueLevel;
  code: string;
  message: string;
}

const HEX_FIELDS = ["primary", "accent", "background", "surface", "text"] as const;

/**
 * Structural + accessibility checks. Errors mean the design will render
 * wrong or unreadably; warnings are taste and WCAG AA nudges the builder
 * may override knowingly. Contrast thresholds are WCAG 2.2 AA: 4.5:1 for
 * text, 3:1 for large text and UI components.
 */
export function validateDesign(design: DesignConfig): DesignIssue[] {
  const issues: DesignIssue[] = [];
  const push = (level: IssueLevel, code: string, message: string) => issues.push({ level, code, message });

  for (const f of HEX_FIELDS) {
    if (!isHexColor(design.colors[f])) push("error", `color.${f}`, `colors.${f} must be a hex colour, got "${design.colors[f]}"`);
  }
  for (const f of ["success", "warning", "danger"] as const) {
    const v = design.colors[f];
    if (v !== undefined && !isHexColor(v)) push("error", `color.${f}`, `colors.${f} must be a hex colour, got "${v}"`);
  }
  if (issues.some((i) => i.level === "error")) return issues;

  const { background, surface, text, primary, accent } = design.colors;
  const r = (a: string, b: string) => Math.round(contrastRatio(a, b) * 100) / 100;

  const textOnBg = r(text, background);
  if (textOnBg < 4.5) push("error", "contrast.text-bg", `Text on background is ${textOnBg}:1; WCAG AA needs 4.5:1.`);
  const textOnSurface = r(text, surface);
  if (textOnSurface < 4.5) push("error", "contrast.text-surface", `Text on surface is ${textOnSurface}:1; WCAG AA needs 4.5:1.`);

  const muted = tintForContrast(background, text, 4.6, 0.5);
  const mutedOnBg = r(muted, background);
  if (mutedOnBg < 4.5) push("warn", "contrast.muted-bg", `Muted text on background is ${mutedOnBg}:1; the ink itself is too close to the canvas.`);

  const labelOnPrimary = r(bestTextOn(primary), primary);
  if (labelOnPrimary < 4.5) push("warn", "contrast.button-label", `Primary button label is ${labelOnPrimary}:1 against the primary colour; aim for 4.5:1.`);

  // WCAG 1.4.11 asks 3:1 for the *boundary* of a control against what
  // surrounds it. A 2px ink border supplies that on its own (the
  // neo-brutalist yellow-on-cream case), so only warn for hairline UIs.
  const primaryOnBg = r(primary, background);
  if (primaryOnBg < 3 && design.shape.borderWidth < 2) {
    push("warn", "contrast.primary-bg", `Primary against background is ${primaryOnBg}:1; links and focus rings need 3:1 (or a 2px border).`);
  }

  const accentOnBg = r(accent, background);
  if (accentOnBg < 3) push("warn", "contrast.accent-bg", `Accent against background is ${accentOnBg}:1; badges will look washed out.`);

  const surfaceVsBg = r(surface, background);
  if (surfaceVsBg < 1.03 && design.shape.borderWidth < 2) {
    push("warn", "surface.flat", "Surface and background are nearly identical; cards will rely on hairline borders alone.");
  }

  const isDarkText = luminance(text) < luminance(background);
  if (design.mode === "light" && !isDarkText) push("warn", "mode.mismatch", "mode is light but text is lighter than the background.");
  if (design.mode === "dark" && isDarkText) push("warn", "mode.mismatch", "mode is dark but text is darker than the background.");

  if (design.type.baseSize < 14 || design.type.baseSize > 20) push("error", "type.base", "type.baseSize must be between 14 and 20.");
  if (design.type.scale < 1.1 || design.type.scale > 1.5) push("error", "type.scale", "type.scale must be between 1.1 and 1.5.");
  if (design.fonts.headingWeight < 300 || design.fonts.headingWeight > 900) push("error", "font.headingWeight", "fonts.headingWeight must be 300–900.");
  if (design.fonts.bodyWeight < 300 || design.fonts.bodyWeight > 600) push("error", "font.bodyWeight", "fonts.bodyWeight must be 300–600.");
  for (const f of ["heading", "body", "mono"] as const) {
    if (!design.fonts[f] || !design.fonts[f].trim()) push("error", `font.${f}`, `fonts.${f} is required.`);
  }
  return issues;
}

export function hasErrors(issues: DesignIssue[]): boolean {
  return issues.some((i) => i.level === "error");
}
