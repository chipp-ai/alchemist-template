/**
 * Everything the landing pages say comes from src/content/site.json. The
 * JSON-LD is built from the same values, so the structured data always
 * matches the visible text (scripts/aeo-check.mjs fails the build if not).
 *
 * Brand tokens come from the app's own design file
 * (../web/src/design/design.json) at build time, so the landing site and
 * the app share colors, fonts, corners and shadows. Contrast math comes from
 * the app's own tokens (../web/src/design/tokens.ts), so a label on the
 * primary color is picked the same way in both places. src/styles/theme.css
 * can override any of them (the build writes it from the approved plan's
 * prototype styles).
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import raw from "../content/site.json";
import { bestTextOn, contrastRatio, mix, shadowValues, tintForContrast } from "../../../web/src/design/tokens.ts";

export interface SiteFaq {
  question: string;
  answer: string;
}

export interface SitePlan {
  name: string;
  price: string;
  period: string;
  description: string;
  features: string[];
}

/** A titled block of copy: a feature, a step, a kind of reader. */
export interface SiteBlock {
  title: string;
  body: string;
}

export interface SiteLink {
  label: string;
  href: string;
}

export interface SiteContent {
  /**
   * What the deployed root URL "/" serves. "landing" (the default) serves
   * this site; "app" serves the app there instead (an app-first product),
   * and this site is not served at all. Read by src/lib/landing-site.ts.
   */
  homepage?: "landing" | "app";
  name: string;
  /** The public origin, e.g. "https://acme.on.chipp.ai". "" when unknown. */
  url: string;
  description: string;
  definition: { what: string; who: string; does: string };
  /** The reader's main question. The home page shows it first in the FAQ. */
  mainQuestion: string;
  /** Its honest "it depends" answer, 100 words or less. */
  itDependsAnswer: string;
  features: SiteBlock[];
  faq: SiteFaq[];
  testimonials: { quote: string; name: string; role: string }[];
  pricing: { question: string; answer: string; plans: SitePlan[] };
  about: { question: string; answer: string; body: string };
  cta: SiteLink;
  /**
   * The home page hero. `headline` is the H1: one sharp line about what the
   * reader gets, not the product name. `subhead` is the plain definition
   * under it. Optional so an older site.json still builds: the page falls
   * back to the name and definition.what.
   */
  hero?: { eyebrow?: string; headline: string; subhead: string; secondaryCta?: SiteLink };
  /** Who it is for: one block per kind of reader. */
  audience?: SiteBlock[];
  /** How it works: the steps a new user takes, in order (three is best). */
  steps?: SiteBlock[];
  /**
   * A picture of the product: a screenshot in landing/public, for example
   * "/product.png". Without one the home page draws a product sketch in
   * HTML and CSS from the features.
   */
  productShot?: { src: string; alt: string; width?: number; height?: number } | null;
  /**
   * True while this file is the platform's first draft and no person has
   * changed it. The build agent may rewrite a starter landing from the
   * approved plan. Any edit a person asks for sets it to false.
   */
  starter?: boolean;
  /** "Month Year", shown as "as of <asOf>" next to key facts. */
  asOf: string;
  /** ISO dates (YYYY-MM-DD). */
  publishedAt: string;
  updatedAt: string;
}

export const site: SiteContent = raw as SiteContent;

export interface Brand {
  primary: string;
  accent: string;
  background: string;
  surface: string;
  text: string;
  headingFont: string;
  bodyFont: string;
  headingWeight: number;
  bodyWeight: number;
  radius: string;
  /** Border width in px (1 hairline, 2 drawn). */
  borderWidth: number;
  /** "soft", "hard" or "none", from design.json shape.shadow. */
  shadow: string;
  /** Heading letter spacing, in em. */
  headingTracking: number;
  /** "upper" sets headings in capitals. */
  headingCase: string;
  /** Label color on a `primary` fill: near-white or near-black, by contrast. */
  primaryContrast: string;
  /** Link color on the page background: `primary` when it reads (4.5:1), else `text`. */
  link: string;
  /** Secondary text: the lightest ink tint that still reads at 4.5:1. */
  muted: string;
  /** A soft band of primary over the page background. */
  tint: string;
  /** Hairline color for borders. */
  line: string;
  /** Shadows for small, medium and large surfaces. */
  shadowSm: string;
  shadowMd: string;
  shadowLg: string;
}

type DerivedKeys = "primaryContrast" | "link" | "muted" | "tint" | "line" | "shadowSm" | "shadowMd" | "shadowLg";
type BaseBrand = Omit<Brand, DerivedKeys>;

const DEFAULT_BRAND: BaseBrand = {
  primary: "#4f46e5",
  accent: "#0284c7",
  background: "#f8fafc",
  surface: "#ffffff",
  text: "#0f172a",
  headingFont: "Inter",
  bodyFont: "Inter",
  headingWeight: 600,
  bodyWeight: 400,
  radius: "8px",
  borderWidth: 1,
  shadow: "soft",
  headingTracking: -0.02,
  headingCase: "normal",
};

const RADIUS: Record<string, string> = {
  none: "0",
  sm: "4px",
  md: "8px",
  lg: "14px",
  xl: "20px",
  pill: "999px",
  full: "999px",
};

/**
 * Add the colors derived from the base tokens. A design can pick any primary
 * (a white primary on a dark canvas is a real design choice), so the button
 * label, the link color and the muted text are never hardcoded.
 */
export function withDerivedColors(b: BaseBrand): Brand {
  const preset = b.shadow === "hard" || b.shadow === "none" ? b.shadow : "soft";
  const shadows = shadowValues(preset, b.text);
  return {
    ...b,
    primaryContrast: bestTextOn(b.primary),
    link: contrastRatio(b.primary, b.background) >= 4.5 ? b.primary : b.text,
    muted: tintForContrast(b.background, b.text, 4.5, 0.55),
    tint: mix(b.background, b.primary, 0.07),
    line: mix(b.background, b.text, 0.12),
    shadowSm: shadows.sm,
    shadowMd: shadows.md,
    shadowLg: shadows.lg,
  };
}

/** Read brand tokens from the app's design.json. Falls back to defaults when it is missing. */
export function loadBrand(): Brand {
  return withDerivedColors(loadBaseBrand());
}

function loadBaseBrand(): BaseBrand {
  try {
    const file = resolve(process.cwd(), "../web/src/design/design.json");
    const d = JSON.parse(readFileSync(file, "utf8"));
    return {
      primary: d.colors?.primary ?? DEFAULT_BRAND.primary,
      accent: d.colors?.accent ?? DEFAULT_BRAND.accent,
      background: d.colors?.background ?? DEFAULT_BRAND.background,
      surface: d.colors?.surface ?? DEFAULT_BRAND.surface,
      text: d.colors?.text ?? DEFAULT_BRAND.text,
      headingFont: d.fonts?.heading ?? DEFAULT_BRAND.headingFont,
      bodyFont: d.fonts?.body ?? DEFAULT_BRAND.bodyFont,
      headingWeight: d.fonts?.headingWeight ?? DEFAULT_BRAND.headingWeight,
      bodyWeight: d.fonts?.bodyWeight ?? DEFAULT_BRAND.bodyWeight,
      radius: RADIUS[d.shape?.radius] ?? DEFAULT_BRAND.radius,
      borderWidth: d.shape?.borderWidth === 2 ? 2 : 1,
      shadow: d.shape?.shadow ?? DEFAULT_BRAND.shadow,
      headingTracking: typeof d.type?.headingTracking === "number"
        ? d.type.headingTracking
        : DEFAULT_BRAND.headingTracking,
      headingCase: d.type?.headingCase === "upper" ? "upper" : "normal",
    };
  } catch {
    return DEFAULT_BRAND;
  }
}

/**
 * The home page FAQ: the reader's main question and its honest answer
 * first, then the rest. The page and its FAQPage JSON-LD both read this
 * list, so the two always match.
 */
export function homeFaq(content: SiteContent = site): SiteFaq[] {
  const main = content.mainQuestion?.trim() && content.itDependsAnswer?.trim()
    ? [{ question: content.mainQuestion.trim(), answer: content.itDependsAnswer.trim() }]
    : [];
  const rest = content.faq.filter((f) => f.question.trim() !== content.mainQuestion?.trim());
  return [...main, ...rest];
}

export interface HomeHero {
  eyebrow: string;
  headline: string;
  subhead: string;
  secondaryCta: SiteLink | null;
}

/** The hero, with fallbacks for an older site.json that has none. */
export function homeHero(content: SiteContent = site): HomeHero {
  const hero = content.hero;
  return {
    eyebrow: hero?.eyebrow?.trim() || content.name,
    headline: hero?.headline?.trim() || content.name,
    subhead: hero?.subhead?.trim() || content.definition.what,
    secondaryCta: hero?.secondaryCta?.label && hero.secondaryCta.href ? hero.secondaryCta : null,
  };
}

/** "2026-10-19" -> "October 19, 2026". */
export function formatDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  return d.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });
}

/** An absolute URL when the site URL is known, else the path. */
export function absoluteUrl(path: string): string {
  const base = site.url.replace(/\/+$/, "");
  return base ? `${base}${path}` : path;
}

/** The JSON-LD graph for a page. `faq` is set only on pages that show the FAQ. */
export function jsonLd(page: { path: string; title: string; description: string; faq?: SiteFaq[] }): object {
  const org: Record<string, unknown> = { "@type": "Organization", "@id": "#organization", name: site.name };
  if (site.url) org.url = site.url;

  const app: Record<string, unknown> = {
    "@type": "SoftwareApplication",
    name: site.name,
    description: site.definition.what,
    applicationCategory: "BusinessApplication",
    operatingSystem: "Web",
    publisher: { "@id": "#organization" },
  };
  if (site.url) app.url = site.url;
  if (site.productShot?.src) app.screenshot = absoluteUrl(site.productShot.src);

  const webPage: Record<string, unknown> = {
    "@type": "WebPage",
    name: page.title,
    description: page.description,
    datePublished: site.publishedAt,
    dateModified: site.updatedAt,
    about: { "@type": "SoftwareApplication", name: site.name },
  };
  if (site.url) webPage.url = absoluteUrl(page.path);

  const graph: object[] = [org, app, webPage];
  if (page.faq && page.faq.length > 0) {
    graph.push({
      "@type": "FAQPage",
      mainEntity: page.faq.map((f) => ({
        "@type": "Question",
        name: f.question,
        acceptedAnswer: { "@type": "Answer", text: f.answer },
      })),
    });
  }
  return { "@context": "https://schema.org", "@graph": graph };
}

/** JSON for an inline <script>: "<" escaped so text can never close the tag. */
export function scriptJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

/** The pages in the nav and the sitemap (lib/pages.ts). */
export { PAGES, sitemapPages } from "./pages";
