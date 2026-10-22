/**
 * Everything the landing pages say comes from src/content/site.json. The
 * JSON-LD is built from the same values, so the structured data always
 * matches the visible text (scripts/aeo-check.mjs fails the build if not).
 *
 * Brand tokens come from the app's own design file
 * (../web/src/design/design.json) at build time, so the landing site and
 * the app share colors and fonts. Contrast math comes from the app's own
 * tokens (../web/src/design/tokens.ts), so a label on the primary color is
 * picked the same way in both places.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import raw from "../content/site.json";
import { bestTextOn, contrastRatio } from "../../../web/src/design/tokens.ts";

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

export interface SiteContent {
  name: string;
  /** The public origin, e.g. "https://acme.on.chipp.ai". "" when unknown. */
  url: string;
  description: string;
  definition: { what: string; who: string; does: string };
  mainQuestion: string;
  itDependsAnswer: string;
  features: { title: string; body: string }[];
  faq: SiteFaq[];
  testimonials: { quote: string; name: string; role: string }[];
  pricing: { question: string; answer: string; plans: SitePlan[] };
  about: { question: string; answer: string; body: string };
  cta: { label: string; href: string };
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
  /** Label color on a `primary` fill: near-white or near-black, by contrast. */
  primaryContrast: string;
  /** Link color on the page background: `primary` when it reads (3:1), else `text`. */
  link: string;
}

type BaseBrand = Omit<Brand, "primaryContrast" | "link">;

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
};

const RADIUS: Record<string, string> = { none: "0", sm: "4px", md: "8px", lg: "14px", xl: "20px", full: "999px" };

/**
 * Add the colors derived from the base tokens. A design can pick any primary
 * (a white primary on a dark canvas is a real design choice), so the button
 * label and the link color are never hardcoded.
 */
export function withDerivedColors(b: BaseBrand): Brand {
  return {
    ...b,
    primaryContrast: bestTextOn(b.primary),
    link: contrastRatio(b.primary, b.background) >= 3 ? b.primary : b.text,
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
    };
  } catch {
    return DEFAULT_BRAND;
  }
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

/** The pages in the nav and the sitemap. */
export const PAGES: { path: string; label: string }[] = [
  { path: "/", label: "Home" },
  { path: "/pricing/", label: "Pricing" },
  { path: "/about/", label: "About" },
];
