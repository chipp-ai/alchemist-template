/**
 * Everything the landing build reads besides site.json: composed pages
 * (src/content/pages/*.json), blog posts (src/content/posts/*.json) and the
 * approved custom code (src/content/custom-code.json). Validated once at
 * build time: a bad file fails `astro build` with every problem listed.
 *
 * See lib/composed.ts for the shapes and the rules.
 */
import {
  type BlogPost,
  type BlogSettings,
  type ComposedPage,
  normalizePagePath,
  siteContentProblems,
} from "./composed";
import { type LandingPage, PAGES } from "./pages";
import { site, type SiteLink } from "./site";

const pageFiles = import.meta.glob("../content/pages/**/*.json", { eager: true, import: "default" });
const postFiles = import.meta.glob("../content/posts/**/*.json", { eager: true, import: "default" });
const customCodeFiles = import.meta.glob("../content/custom-code.json", { eager: true, import: "default" });

function entries(files: Record<string, unknown>): { file: string; data: unknown }[] {
  return Object.entries(files)
    .map(([file, data]) => ({ file: file.replace(/^\.\.\//, "src/"), data }))
    .sort((a, b) => a.file.localeCompare(b.file));
}

const rawPages = entries(pageFiles);
const rawPosts = entries(postFiles);

const problems = siteContentProblems(rawPages, rawPosts, site.blog);
if (rawPosts.length > 0 && !site.blog) {
  problems.push('blog posts need "blog" in site.json: { "path": "/blog/", "title": ..., "description": ... }');
}
if (problems.length > 0) {
  throw new Error(`[landing content] ${problems.length} problem(s):\n  - ${problems.join("\n  - ")}`);
}

/** Composed pages, paths normalized ("/about" -> "/about/"). */
export const composedPages: ComposedPage[] = rawPages
  .map(({ data }) => {
    const page = data as ComposedPage;
    return { ...page, path: normalizePagePath(page.path) };
  })
  .sort((a, b) => a.path.localeCompare(b.path));

/** Blog posts, newest first. */
export const posts: BlogPost[] = rawPosts
  .map(({ data }) => {
    const post = data as BlogPost;
    return { ...post, path: normalizePagePath(post.path) };
  })
  .sort((a, b) => b.date.localeCompare(a.date) || a.path.localeCompare(b.path));

/** The blog list settings, path normalized, or null when the site has no blog. */
export const blog: BlogSettings | null = site.blog ? { ...site.blog, path: normalizePagePath(site.blog.path) } : null;

/** A composed page claims "/": every page comes from src/content/pages/. */
export const isComposedSite: boolean = composedPages.some((p) => p.path === "/");

/** The composed page at a path, if any. */
export function composedPageAt(path: string): ComposedPage | undefined {
  const key = normalizePagePath(path);
  return composedPages.find((p) => p.path === key);
}

/**
 * The classic pages that are built: all three on a classic site, minus any
 * a composed page replaces; none on a composed site (its "/" is composed).
 */
export const classicPages: LandingPage[] = isComposedSite ? [] : PAGES.filter((p) => !composedPageAt(p.path));

/** The site's date range for a page: its own dates, or site.json's. */
export function pageDates(page: { publishedAt?: string; updatedAt?: string }): { published: string; updated: string } {
  return { published: page.publishedAt ?? site.publishedAt, updated: page.updatedAt ?? site.updatedAt };
}

/** Every indexable page, for the sitemap. */
export function sitePages(): LandingPage[] {
  const list: LandingPage[] = [...classicPages];
  const classicHome = classicPages.some((p) => p.path === "/");
  for (const p of composedPages) {
    if (p.seo?.noindex) continue;
    if (p.path === "/" && classicHome) continue;
    list.push({ path: p.path, label: p.navLabel ?? p.title, lastmod: pageDates(p).updated });
  }
  if (blog) {
    list.push({ path: blog.path, label: blog.navLabel ?? blog.title, lastmod: (posts[0]?.updatedAt ?? posts[0]?.date)?.slice(0, 10) });
    for (const post of posts) {
      if (post.seo?.noindex) continue;
      list.push({ path: post.path, label: post.title, lastmod: (post.updatedAt ?? post.date).slice(0, 10) });
    }
  }
  return list;
}

function generatedNav(): SiteLink[] {
  const links: SiteLink[] = classicPages.filter((p) => p.path !== "/").map((p) => ({ label: p.label, href: p.path }));
  const composed = composedPages
    .filter((p) => p.navLabel && p.path !== "/")
    .sort((a, b) => (a.navOrder ?? 100) - (b.navOrder ?? 100) || a.path.localeCompare(b.path));
  for (const p of composed) links.push({ label: p.navLabel as string, href: p.path });
  if (blog?.navLabel) links.push({ label: blog.navLabel, href: blog.path });
  return links;
}

/** The header links (without the home link and the CTA button). */
export function headerLinks(): SiteLink[] {
  return site.nav?.header ?? generatedNav();
}

/** The footer links. */
export function footerLinks(): SiteLink[] {
  return site.nav?.footer ?? [{ label: "Home", href: "/" }, ...generatedNav()];
}

// ── Custom code ──

export interface CustomCodeSnippet {
  /** What it is: "Google Analytics", "Meta pixel". */
  name: string;
  placement: "head" | "bodyEnd";
  /** The snippet exactly as the provider gives it. */
  html: string;
  /** Who approved it and when (ISO date). A snippet without approval is not rendered. */
  approvedBy: string;
  approvedAt: string;
}

function customCodeSnippets(): CustomCodeSnippet[] {
  const file = customCodeFiles["../content/custom-code.json"] as { snippets?: unknown } | undefined;
  if (!file) return [];
  const list = Array.isArray(file.snippets) ? file.snippets : [];
  const bad: string[] = [];
  list.forEach((s, i) => {
    const where = `src/content/custom-code.json snippets[${i}]`;
    const c = (s && typeof s === "object" ? s : {}) as Record<string, unknown>;
    if (c.placement !== "head" && c.placement !== "bodyEnd") bad.push(`${where}.placement: "head" or "bodyEnd"`);
    if (typeof c.html !== "string" || !c.html.trim()) bad.push(`${where}.html: required`);
    if (typeof c.name !== "string" || !c.name.trim()) bad.push(`${where}.name: required`);
  });
  if (bad.length > 0) throw new Error(`[landing content] custom code:\n  - ${bad.join("\n  - ")}`);
  return (list as CustomCodeSnippet[]).filter((s) => typeof s.approvedAt === "string" && /^\d{4}-\d{2}-\d{2}/.test(s.approvedAt) && !!s.approvedBy?.trim());
}

const snippets = customCodeSnippets();

/**
 * The approved snippets for one placement, wrapped in markers so the AEO
 * check can skip third-party markup it does not own (a tracking pixel's
 * <img> has no alt text).
 */
export function customCode(placement: "head" | "bodyEnd"): string {
  const html = snippets.filter((s) => s.placement === placement).map((s) => s.html).join("\n");
  return html ? `<!--custom-code-->\n${html}\n<!--/custom-code-->` : "";
}
