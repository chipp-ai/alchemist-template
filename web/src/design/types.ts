/**
 * Design system config — the single source of truth for how this app looks.
 *
 * `web/src/design/design.json` holds one `DesignConfig`. At boot the SPA
 * turns it into CSS custom properties (see tokens.ts + apply.ts) that every
 * component reads through `var(--...)`. Change the JSON, hard-reload, and
 * the whole app re-skins: fonts, palette, corner radius, shadows, type
 * scale, density.
 *
 * The file is deliberately small and flat so a chat agent can edit it from
 * a sentence ("make the headings a serif and the buttons rounder") and so
 * the /#/design page can round-trip it through a form.
 *
 * This module is dependency-free and imported by BOTH the SPA and the Deno
 * API (src/services/design.service.ts), so keep it plain TypeScript.
 */

export type DesignMode = "light" | "dark";
export type RadiusPreset = "none" | "sm" | "md" | "lg" | "pill";
export type ShadowPreset = "none" | "soft" | "hard";
export type Density = "compact" | "comfortable" | "spacious";
export type HeadingCase = "normal" | "upper";

export interface DesignFonts {
  /** Google Fonts family for h1–h6 and display text (the "primary" font). */
  heading: string;
  /** Family for body copy and UI chrome (the "secondary" font). */
  body: string;
  /** Family for code, kbd and tabular numerals (the "tertiary" font). */
  mono: string;
  /** Weight for headings; snapped to the nearest weight the family ships. */
  headingWeight: number;
  /** Weight for body text (400 or 500). */
  bodyWeight: number;
}

export interface DesignColors {
  /** Action color: primary buttons, links, focus rings, active nav. */
  primary: string;
  /** Second brand hue for badges, highlights and charts. Used sparingly. */
  accent: string;
  /** Page canvas. */
  background: string;
  /** Cards, panels, sidebar. Slightly separated from the canvas. */
  surface: string;
  /** Ink: body text and headings. Secondary/muted text are derived. */
  text: string;
  /** Optional semantic overrides; sensible defaults per mode otherwise. */
  success?: string;
  warning?: string;
  danger?: string;
}

export interface DesignShape {
  radius: RadiusPreset;
  /** 1 = hairline UI, 2 = drawn/neo-brutalist. */
  borderWidth: 1 | 2;
  shadow: ShadowPreset;
}

export interface DesignType {
  /** Root font size in px. 15–18. */
  baseSize: number;
  /** Modular scale ratio between steps: 1.2 (minor third), 1.25, 1.333. */
  scale: number;
  /** Letter-spacing for headings in em, e.g. -0.02 for tight grotesks. */
  headingTracking: number;
  headingCase: HeadingCase;
}

export interface DesignConfig {
  version: 1;
  /** Preset this design was derived from, or null when hand-built. */
  preset: string | null;
  /** Human label shown on the design page. */
  name: string;
  mode: DesignMode;
  fonts: DesignFonts;
  colors: DesignColors;
  shape: DesignShape;
  type: DesignType;
  density: Density;
}

export const RADIUS_PRESETS: readonly RadiusPreset[] = ["none", "sm", "md", "lg", "pill"];
export const SHADOW_PRESETS: readonly ShadowPreset[] = ["none", "soft", "hard"];
export const DENSITIES: readonly Density[] = ["compact", "comfortable", "spacious"];
export const HEADING_CASES: readonly HeadingCase[] = ["normal", "upper"];
export const TYPE_SCALES: readonly number[] = [1.125, 1.2, 1.25, 1.333];
