/**
 * The landing pages, for the nav and the sitemap. No imports, so the server
 * tests (src/__tests__/routes/landing-site.test.ts) can load it directly.
 */

export interface LandingPage {
  path: string;
  label: string;
  /** The sitemap lastmod (ISO date). Default: site.json updatedAt. */
  lastmod?: string;
}

/** The classic pages (home, pricing, about). Composed pages and the blog are added by lib/content.ts. */
export const PAGES: LandingPage[] = [
  { path: "/", label: "Home" },
  { path: "/pricing/", label: "Pricing" },
  { path: "/about/", label: "About" },
];

/**
 * The pages the sitemap lists. In app-first mode (`"homepage": "app"`) the
 * server serves the app at "/" and does not serve the marketing pages
 * (src/lib/landing-site.ts redirects them to "/"), so only "/" is listed.
 */
export function sitemapPages(homepage: string | undefined, pages: LandingPage[] = PAGES): LandingPage[] {
  return homepage === "app" ? pages.filter((p) => p.path === "/") : pages;
}
