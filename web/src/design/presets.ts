/**
 * Design presets — the "on rails" starting points.
 *
 * Each preset is a complete DesignConfig plus the language a builder uses
 * to ask for it (`vibe`) and the reasoning behind its choices
 * (`rationale`), so a chat agent can map "make it feel premium and calm"
 * to `luxury` and explain the trade-offs. Presets are starting points:
 * apply one, then adjust a font or the primary colour.
 *
 * Every preset passes validateDesign() with zero errors (pinned by
 * src/__tests__/services/design.test.ts): body text ≥ 4.5:1 on canvas and
 * surface, button labels ≥ 4.5:1, primary ≥ 3:1 against the canvas.
 *
 * Grounding (see docs/design-principles.md for sources):
 *   - Pair by contrast in construction (serif + sans, geometric + humanist)
 *     or stay inside a superfamily (Plex, Source, DM, Geist).
 *   - One radius family per design; none reads formal, large reads playful.
 *   - 60/30/10: canvas, structure, action. Accent is rarer than primary.
 *   - Modular type scale 1.2–1.333 off a 16px base; 1.333 only when there
 *     is little dense text.
 */

import type { DesignConfig } from "./types.ts";

export interface DesignPreset {
  id: string;
  label: string;
  /** One sentence for the picker. */
  summary: string;
  /** Words a user says that should map here. */
  vibe: string[];
  /** Product categories it suits. */
  suits: string[];
  /** Why these choices, in two or three sentences. */
  rationale: string;
  design: DesignConfig;
}

const base = {
  version: 1 as const,
  fonts: { headingWeight: 700, bodyWeight: 400 },
  type: { baseSize: 16, scale: 1.2, headingTracking: -0.01, headingCase: "normal" as const },
};

export const DESIGN_PRESETS: DesignPreset[] = [
  {
    id: "clean",
    label: "Clean SaaS",
    summary: "Neutral, modern product UI. The template default; a starting point, not a destination.",
    vibe: ["clean", "simple", "modern", "default", "neutral", "saas", "dashboard"],
    suits: ["B2B tools", "admin panels", "anything undecided"],
    rationale:
      "Inter for everything keeps the interface quiet so data carries the hierarchy. A cool indigo primary is the most recognisable 'action' colour in software, and an 8px radius family reads competent without personality. Pick this when the product's own content is the brand.",
    design: {
      ...base,
      preset: "clean",
      name: "Clean SaaS",
      mode: "light",
      fonts: { ...base.fonts, heading: "Inter", body: "Inter", mono: "JetBrains Mono", headingWeight: 600 },
      colors: { primary: "#4f46e5", accent: "#0284c7", background: "#f8fafc", surface: "#ffffff", text: "#0f172a" },
      shape: { radius: "md", borderWidth: 1, shadow: "soft" },
      type: { ...base.type, headingTracking: -0.02 },
      density: "comfortable",
    },
  },
  {
    id: "modern",
    label: "Modern tech",
    summary: "Grotesk headings, geometric body, cool blue action colour, generous radii.",
    vibe: ["tech", "startup", "modern", "sleek", "developer", "ai", "product-led"],
    suits: ["developer tools", "AI products", "fintech apps"],
    rationale:
      "Space Grotesk's quirks give headings a voice while DM Sans stays even in dense UI; both are low-contrast geometrics so they agree on proportions. A saturated blue primary with a violet accent is the current tech vernacular, and the large radius family softens an otherwise engineered look.",
    design: {
      ...base,
      preset: "modern",
      name: "Modern tech",
      mode: "light",
      fonts: { ...base.fonts, heading: "Space Grotesk", body: "DM Sans", mono: "Geist Mono", headingWeight: 700 },
      colors: { primary: "#2563eb", accent: "#7c3aed", background: "#ffffff", surface: "#f4f6fa", text: "#0b0f19" },
      shape: { radius: "lg", borderWidth: 1, shadow: "soft" },
      type: { ...base.type, scale: 1.25, headingTracking: -0.02 },
      density: "comfortable",
    },
  },
  {
    id: "editorial",
    label: "Editorial",
    summary: "Serif display headings on warm paper, deep brick action colour, sharp corners.",
    vibe: ["editorial", "magazine", "publishing", "literary", "journal", "newsletter", "content"],
    suits: ["publishing", "media", "newsletters", "knowledge products"],
    rationale:
      "Fraunces gives headlines the warmth of print without the fragility of a Didone at UI sizes; Source Sans 3 is the calm text partner that keeps forms readable. Off-white paper instead of pure white lowers glare for long reading, and a small radius with no shadows keeps the page feeling typeset rather than 'app'.",
    design: {
      ...base,
      preset: "editorial",
      name: "Editorial",
      mode: "light",
      fonts: { ...base.fonts, heading: "Fraunces", body: "Source Sans 3", mono: "IBM Plex Mono", headingWeight: 600 },
      colors: { primary: "#8b2e1f", accent: "#2f6f5e", background: "#fbf7f0", surface: "#ffffff", text: "#1f1a17" },
      shape: { radius: "sm", borderWidth: 1, shadow: "none" },
      type: { ...base.type, scale: 1.25, headingTracking: -0.01 },
      density: "comfortable",
    },
  },
  {
    id: "friendly",
    label: "Friendly & playful",
    summary: "Rounded humanist type, pill buttons, a warm raspberry primary and a tangerine accent.",
    vibe: ["friendly", "playful", "fun", "warm", "approachable", "consumer", "kids", "community"],
    suits: ["consumer apps", "education", "community", "wellness for a younger audience"],
    rationale:
      "Nunito's rounded terminals do the smiling for you; keep them at 800 for headings and lean on Nunito Sans for body so long text does not get cartoonish. Pill controls and a spacious density read as unhurried and kind. The raspberry primary is saturated enough to feel energetic but still passes AA with a white label.",
    design: {
      ...base,
      preset: "friendly",
      name: "Friendly & playful",
      mode: "light",
      fonts: { ...base.fonts, heading: "Nunito", body: "Nunito Sans", mono: "Fira Code", headingWeight: 800 },
      colors: { primary: "#c81e6b", accent: "#c2410c", background: "#fffbf5", surface: "#ffffff", text: "#2b2437" },
      shape: { radius: "pill", borderWidth: 1, shadow: "soft" },
      type: { ...base.type, scale: 1.2, headingTracking: -0.01 },
      density: "spacious",
    },
  },
  {
    id: "corporate",
    label: "Corporate trust",
    summary: "One superfamily, restrained blue, small radii, no shadows. Built to look audited.",
    vibe: ["corporate", "enterprise", "professional", "trust", "bank", "insurance", "government", "serious", "compliance"],
    suits: ["finance", "insurance", "legal", "healthcare admin", "enterprise B2B"],
    rationale:
      "IBM Plex is a superfamily, so heading, body and mono share metrics and the interface never argues with itself. A conservative blue primary and teal accent signal stability; the small radius and hairline borders avoid anything that reads as marketing. Compact spacing suits the dense tables these products live on.",
    design: {
      ...base,
      preset: "corporate",
      name: "Corporate trust",
      mode: "light",
      fonts: { ...base.fonts, heading: "IBM Plex Sans", body: "IBM Plex Sans", mono: "IBM Plex Mono", headingWeight: 600 },
      colors: { primary: "#0b5cab", accent: "#0f766e", background: "#f4f6f8", surface: "#ffffff", text: "#1b2430" },
      shape: { radius: "sm", borderWidth: 1, shadow: "none" },
      type: { ...base.type, scale: 1.2, headingTracking: 0 },
      density: "compact",
    },
  },
  {
    id: "luxury",
    label: "Luxury minimal",
    summary: "Delicate serif headings, geometric body, ivory canvas, black actions, gold accent, no radius.",
    vibe: ["luxury", "premium", "elegant", "minimal", "fashion", "boutique", "high-end", "calm", "refined"],
    suits: ["fashion", "hospitality", "real estate", "jewellery", "concierge services"],
    rationale:
      "Cormorant Garamond at a light weight and a 1.333 scale gives headings air; Jost's Futura DNA supplies the modern counterpoint that luxury brands favour. Black-on-ivory with a single muted gold accent follows 60/30/10 strictly, and zero radius plus spacious density signals restraint. Use it only where text is sparse; the scale is too big for dense tables.",
    design: {
      ...base,
      preset: "luxury",
      name: "Luxury minimal",
      mode: "light",
      fonts: { ...base.fonts, heading: "Cormorant Garamond", body: "Jost", mono: "IBM Plex Mono", headingWeight: 600 },
      colors: { primary: "#17151a", accent: "#8a6d2a", background: "#f7f5f0", surface: "#ffffff", text: "#17151a" },
      shape: { radius: "none", borderWidth: 1, shadow: "none" },
      type: { ...base.type, scale: 1.333, headingTracking: 0 },
      density: "spacious",
    },
  },
  {
    id: "brutalist",
    label: "Neo-brutalist",
    summary: "Heavy uppercase headings, 2px borders, hard offset shadows, acid yellow actions.",
    vibe: ["brutalist", "bold", "raw", "loud", "punk", "edgy", "creative", "agency", "indie", "y2k"],
    suits: ["creative agencies", "indie products", "events", "portfolios", "youth brands"],
    rationale:
      "Archivo Black in uppercase is the poster voice; Archivo at text sizes keeps the family consistent. Two-pixel ink borders and hard offset shadows replace blur entirely, which is the defining move of the style. The yellow primary takes a black label (chosen by contrast), so it stays accessible despite the volume.",
    design: {
      ...base,
      preset: "brutalist",
      name: "Neo-brutalist",
      mode: "light",
      fonts: { ...base.fonts, heading: "Archivo Black", body: "Archivo", mono: "Space Mono", headingWeight: 400, bodyWeight: 500 },
      colors: { primary: "#ffd23f", accent: "#ff5a5f", background: "#fffdf5", surface: "#ffffff", text: "#111111" },
      shape: { radius: "none", borderWidth: 2, shadow: "hard" },
      type: { ...base.type, scale: 1.25, headingTracking: 0, headingCase: "upper" },
      density: "comfortable",
    },
  },
  {
    id: "dark",
    label: "Dark console",
    summary: "Dark surfaces, wide geometric headings, cyan actions, violet accent. Developer-tool mood.",
    vibe: ["dark", "dark mode", "console", "terminal", "hacker", "gaming", "night", "neon", "cyber"],
    suits: ["developer tools", "analytics", "gaming", "media players", "crypto"],
    rationale:
      "A blue-black canvas with slightly lifted surfaces keeps depth without grey mush; borders and muted text are derived from ink at low opacity so they stay visible on dark. Sora's width makes headings feel like product names; Manrope keeps body text legible at small sizes. Cyan on dark is high-contrast and takes a dark label, which the token derivation handles.",
    design: {
      ...base,
      preset: "dark",
      name: "Dark console",
      mode: "dark",
      fonts: { ...base.fonts, heading: "Sora", body: "Manrope", mono: "JetBrains Mono", headingWeight: 600 },
      colors: { primary: "#22d3ee", accent: "#a78bfa", background: "#0b0f14", surface: "#131a22", text: "#e6edf3" },
      shape: { radius: "md", borderWidth: 1, shadow: "none" },
      type: { ...base.type, scale: 1.2, headingTracking: -0.01 },
      density: "comfortable",
    },
  },
  {
    id: "organic",
    label: "Warm organic",
    summary: "Calligraphic serif headings, humanist body, sage and clay palette, large soft radii.",
    vibe: ["organic", "natural", "earthy", "wellness", "calm", "health", "sustainable", "craft", "food", "garden"],
    suits: ["wellness", "food and drink", "sustainability", "craft marketplaces", "clinics"],
    rationale:
      "Lora's calligraphic stress reads handmade without becoming a script; Mulish is the low-key humanist body that keeps forms calm. Sage as the action colour is unusual enough to be memorable and dark enough to pass AA with a white label; clay as the accent keeps the palette in one temperature. Large radii and spacious density complete the unhurried tone.",
    design: {
      ...base,
      preset: "organic",
      name: "Warm organic",
      mode: "light",
      fonts: { ...base.fonts, heading: "Lora", body: "Mulish", mono: "Fira Code", headingWeight: 600 },
      colors: { primary: "#3f6b48", accent: "#b9673c", background: "#f6f3ec", surface: "#fffdf9", text: "#2c2a25" },
      shape: { radius: "lg", borderWidth: 1, shadow: "soft" },
      type: { ...base.type, scale: 1.2, headingTracking: -0.005 },
      density: "spacious",
    },
  },
];

export function findPreset(id: string): DesignPreset | undefined {
  const key = id.trim().toLowerCase();
  return DESIGN_PRESETS.find((p) => p.id === key);
}

/**
 * Rank presets by how many of the user's words hit a preset's `vibe`,
 * `label` or `suits`. Empty result means no word matched; fall back to
 * asking or to `clean`.
 */
export function matchPresets(text: string): DesignPreset[] {
  const words = text.toLowerCase().split(/[^a-z0-9-]+/).filter((w) => w.length > 2);
  if (words.length === 0) return [];
  const scored = DESIGN_PRESETS.map((p) => {
    const hay = [...p.vibe, p.label.toLowerCase(), ...p.suits.map((s) => s.toLowerCase())];
    const score = words.reduce((n, w) => n + (hay.some((h) => h.includes(w)) ? 1 : 0), 0);
    return { p, score };
  }).filter((s) => s.score > 0);
  scored.sort((a, b) => b.score - a.score);
  return scored.map((s) => s.p);
}
