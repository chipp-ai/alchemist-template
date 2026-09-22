/**
 * Curated Google Fonts catalog.
 *
 * Google hosts ~1,700 families; loading them all for a dropdown is not an
 * option, and most are not fit for product UI. This list is the set an
 * agent or builder chooses from, grouped by construction so pairings stay
 * sane (serif heading + sans body, grotesk heading + humanist body, etc.).
 * Each entry lists the weights the family actually ships, because the
 * Google CSS API rejects a request for a weight that does not exist.
 *
 * Any Google family outside this list still works (type it in), it just
 * gets no weight metadata, so it is requested at 400 + 700 only.
 *
 * Sources: fonts.google.com/knowledge (pairing principles), Typewolf's
 * Google Fonts shortlist, and the families the platform's builders reach
 * for most. Dependency-free; imported by the SPA and the Deno API.
 */

export type FontCategory = "sans" | "serif" | "display" | "mono";

export interface FontEntry {
  family: string;
  category: FontCategory;
  /** Weights available on Google Fonts, ascending. */
  weights: number[];
  /** One line on the voice of the face, for the agent + the picker. */
  note: string;
}

export const FALLBACK_STACKS: Record<FontCategory, string> = {
  sans: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  serif: 'Georgia, "Times New Roman", Times, serif',
  display: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  mono: '"SF Mono", SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
};

const W4567 = [400, 500, 600, 700];

export const FONT_CATALOG: FontEntry[] = [
  // ── Sans: neutral / UI ──
  { family: "Inter", category: "sans", weights: W4567, note: "The neutral UI default; disappears into the interface." },
  { family: "Geist", category: "sans", weights: W4567, note: "Crisp, slightly technical; developer-tool energy." },
  { family: "Instrument Sans", category: "sans", weights: W4567, note: "Warm grotesk with a little personality; great at 500." },
  { family: "Public Sans", category: "sans", weights: W4567, note: "Sober, civic, highly legible; government and finance." },
  { family: "IBM Plex Sans", category: "sans", weights: W4567, note: "Engineered, humane; pairs with Plex Serif and Mono." },
  { family: "Source Sans 3", category: "sans", weights: W4567, note: "Quiet workhorse for dense text-heavy screens." },
  { family: "Work Sans", category: "sans", weights: W4567, note: "Optimized for screens; friendly at large sizes." },
  { family: "Albert Sans", category: "sans", weights: W4567, note: "Geometric-humanist hybrid; contemporary without being cold." },
  { family: "Onest", category: "sans", weights: W4567, note: "Soft, modern, slightly narrow; good for dashboards." },
  // ── Sans: geometric / modern ──
  { family: "DM Sans", category: "sans", weights: [400, 500, 700], note: "Low-contrast geometric; the SaaS default of the moment." },
  { family: "Manrope", category: "sans", weights: [400, 500, 600, 700, 800], note: "Geometric with open forms; tech and fintech." },
  { family: "Plus Jakarta Sans", category: "sans", weights: [400, 500, 600, 700, 800], note: "Rounded geometric; startup landing pages." },
  { family: "Sora", category: "sans", weights: [400, 500, 600, 700, 800], note: "Wide geometric; strong headings for product marketing." },
  { family: "Space Grotesk", category: "sans", weights: W4567, note: "Quirky grotesk with mono roots; tech with attitude." },
  { family: "Outfit", category: "sans", weights: W4567, note: "Clean geometric display sans; bold headings." },
  { family: "Figtree", category: "sans", weights: [400, 500, 600, 700, 800], note: "Friendly geometric; approachable consumer apps." },
  { family: "Lexend", category: "sans", weights: W4567, note: "Wide, readable; designed to reduce reading fatigue." },
  { family: "Jost", category: "sans", weights: W4567, note: "Futura-like geometric; fashion, architecture, luxury." },
  { family: "Poppins", category: "sans", weights: W4567, note: "Round geometric; popular but easily generic." },
  { family: "Montserrat", category: "sans", weights: [400, 500, 600, 700, 800], note: "Urban geometric; strong in uppercase." },
  // ── Sans: humanist / friendly ──
  { family: "Nunito Sans", category: "sans", weights: [400, 600, 700, 800], note: "Soft humanist; warm and readable." },
  { family: "Nunito", category: "sans", weights: [400, 600, 700, 800], note: "Rounded terminals; playful consumer and education." },
  { family: "Mulish", category: "sans", weights: [400, 500, 600, 700, 800], note: "Minimalist humanist; calm health and wellness UIs." },
  { family: "Quicksand", category: "sans", weights: W4567, note: "Very round; childlike, gentle." },
  { family: "Karla", category: "sans", weights: W4567, note: "Slightly irregular grotesk; handmade feel." },
  { family: "Rubik", category: "sans", weights: W4567, note: "Rounded corners; sturdy and friendly." },
  { family: "Open Sans", category: "sans", weights: W4567, note: "Ubiquitous humanist; safe, a little dated." },
  { family: "Lato", category: "sans", weights: [400, 700], note: "Semi-rounded humanist; corporate warmth." },
  { family: "Roboto", category: "sans", weights: [400, 500, 700], note: "Android default; neutral, mechanical." },
  { family: "Barlow", category: "sans", weights: W4567, note: "Slightly rounded grotesk; industrial, automotive." },
  { family: "Archivo", category: "sans", weights: [400, 500, 600, 700, 800], note: "Grotesk built for print + screen; bold posters." },
  // ── Serif: text ──
  { family: "Source Serif 4", category: "serif", weights: W4567, note: "Transitional text serif; pairs with Source Sans 3." },
  { family: "Lora", category: "serif", weights: W4567, note: "Calligraphic roots; warm editorial body text." },
  { family: "Merriweather", category: "serif", weights: [400, 700], note: "Sturdy screen serif; long-form reading." },
  { family: "Libre Baskerville", category: "serif", weights: [400, 700], note: "Classic Baskerville tuned for screens." },
  { family: "EB Garamond", category: "serif", weights: W4567, note: "Old-style elegance; books, humanities." },
  { family: "Crimson Pro", category: "serif", weights: W4567, note: "Bookish, compact; literary products." },
  { family: "Newsreader", category: "serif", weights: W4567, note: "Newspaper text face; journalism and briefings." },
  { family: "Literata", category: "serif", weights: W4567, note: "Google Play Books face; e-reading comfort." },
  { family: "Spectral", category: "serif", weights: W4567, note: "Screen-first serif with a modern edge." },
  { family: "Bitter", category: "serif", weights: W4567, note: "Slab serif; sturdy, rustic, trustworthy." },
  // ── Serif: display ──
  { family: "Fraunces", category: "serif", weights: W4567, note: "Soft, wonky old-style display; editorial charm." },
  { family: "Playfair Display", category: "serif", weights: W4567, note: "High-contrast Didone; luxury and fashion headlines." },
  { family: "Cormorant Garamond", category: "serif", weights: W4567, note: "Delicate display Garamond; hospitality, luxury." },
  { family: "DM Serif Display", category: "serif", weights: [400], note: "Sharp modern serif for big headlines only." },
  { family: "Instrument Serif", category: "serif", weights: [400], note: "Condensed editorial serif; magazine covers." },
  // ── Display ──
  { family: "Bricolage Grotesque", category: "display", weights: W4567, note: "Expressive grotesk; opinionated headings." },
  { family: "Syne", category: "display", weights: [400, 500, 600, 700, 800], note: "Wide, arty; galleries, culture, agencies." },
  { family: "Unbounded", category: "display", weights: W4567, note: "Extra-wide; crypto, gaming, loud brands." },
  { family: "Archivo Black", category: "display", weights: [400], note: "Heavy grotesk; neo-brutalist posters." },
  { family: "Bebas Neue", category: "display", weights: [400], note: "Condensed all-caps; sports, events." },
  // ── Mono ──
  { family: "JetBrains Mono", category: "mono", weights: W4567, note: "Tall x-height coding mono; the template default." },
  { family: "IBM Plex Mono", category: "mono", weights: [400, 500, 600], note: "Typewriter warmth; pairs with Plex Sans." },
  { family: "Geist Mono", category: "mono", weights: W4567, note: "Clean, modern; matches Geist." },
  { family: "Fira Code", category: "mono", weights: W4567, note: "Ligatures; developer-facing products." },
  { family: "Source Code Pro", category: "mono", weights: W4567, note: "Neutral mono; pairs with Source Sans/Serif." },
  { family: "Space Mono", category: "mono", weights: [400, 700], note: "Retro-futurist; brutalist and sci-fi themes." },
  { family: "DM Mono", category: "mono", weights: [400, 500], note: "Light, elegant mono; matches DM Sans." },
  { family: "Roboto Mono", category: "mono", weights: W4567, note: "Neutral, Android-adjacent." },
  { family: "Inconsolata", category: "mono", weights: W4567, note: "Humanist mono; readable in tables." },
];

export const FONT_CATEGORY_LABELS: Record<FontCategory, string> = {
  sans: "Sans-serif",
  serif: "Serif",
  display: "Display",
  mono: "Monospace",
};

export function findFont(family: string): FontEntry | undefined {
  const key = family.trim().toLowerCase();
  return FONT_CATALOG.find((f) => f.family.toLowerCase() === key);
}

/** Catalog entries of one category, in catalog order. */
export function fontsByCategory(category: FontCategory): FontEntry[] {
  return FONT_CATALOG.filter((f) => f.category === category);
}

/** The catalog weight closest to `want`; 400/700 for unknown families. */
export function nearestWeight(family: string, want: number): number {
  const entry = findFont(family);
  const weights = entry?.weights ?? [400, 700];
  return weights.reduce((best, w) => (Math.abs(w - want) < Math.abs(best - want) ? w : best));
}

/** Category for a family, guessing "sans" for unknown families. */
export function fontCategory(family: string): FontCategory {
  return findFont(family)?.category ?? "sans";
}

/** `"Fraunces", Georgia, ...` — the family quoted plus its category fallback stack. */
export function fontStack(family: string): string {
  const cat = fontCategory(family);
  return `"${family.trim()}", ${FALLBACK_STACKS[cat]}`;
}

export interface FontRequest {
  family: string;
  weights: number[];
}

/**
 * Build a Google Fonts CSS2 URL. Weights are deduped + sorted; `text`
 * subsets the download to just those glyphs (specimen previews).
 */
export function googleFontsUrl(
  requests: FontRequest[],
  opts: { text?: string; display?: string } = {},
): string {
  const seen = new Map<string, Set<number>>();
  for (const r of requests) {
    const key = r.family.trim();
    if (!key) continue;
    const set = seen.get(key) ?? new Set<number>();
    for (const w of r.weights) set.add(w);
    seen.set(key, set);
  }
  const params: string[] = [];
  for (const [family, weights] of seen) {
    const fam = family.replace(/ /g, "+");
    const ws = [...weights].sort((a, b) => a - b).join(";");
    params.push(`family=${fam}:wght@${ws}`);
  }
  if (opts.text) params.push(`text=${encodeURIComponent(opts.text)}`);
  params.push(`display=${opts.display ?? "swap"}`);
  return `https://fonts.googleapis.com/css2?${params.join("&")}`;
}

/**
 * The font requests a design needs at runtime: heading at its weight,
 * body at 400 + its weight + 600 (buttons, labels), mono at 400 + 500.
 */
export function fontRequestsFor(fonts: {
  heading: string;
  body: string;
  mono: string;
  headingWeight: number;
  bodyWeight: number;
}): FontRequest[] {
  return [
    { family: fonts.heading, weights: [nearestWeight(fonts.heading, fonts.headingWeight)] },
    {
      family: fonts.body,
      weights: [
        nearestWeight(fonts.body, 400),
        nearestWeight(fonts.body, fonts.bodyWeight),
        nearestWeight(fonts.body, 600),
      ],
    },
    { family: fonts.mono, weights: [nearestWeight(fonts.mono, 400), nearestWeight(fonts.mono, 500)] },
  ];
}
