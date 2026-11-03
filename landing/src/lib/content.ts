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
  type BlogTerms,
  blogTermsProblems,
  catalogProblems,
  type ComposedPage,
  normalizePagePath,
  PRODUCT_ENQUIRY_FORM,
  type ProductCatalog,
  siteContentProblems,
  formsOf,
} from "./composed";
import { type LandingPage, PAGES } from "./pages";
import { hasShop, shopPath, shopPathProblems, shopRoutes } from "./shop";
import { site, type SiteLink } from "./site";

const pageFiles = import.meta.glob("../content/pages/**/*.json", { eager: true, import: "default" });
const postFiles = import.meta.glob("../content/posts/**/*.json", { eager: true, import: "default" });
const customCodeFiles = import.meta.glob("../content/custom-code.json", { eager: true, import: "default" });
// Read as text, so an empty file (or "{}") means "no shop" instead of a parse error.
const dataFiles = import.meta.glob(["../content/products.json", "../content/blog-terms.json"], { eager: true, query: "?raw", import: "default" });

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
/** An optional data file: undefined when absent, empty or "{}". */
function optionalJson(name: string): unknown {
  const text = dataFiles[`../content/${name}`] as string | undefined;
  if (text === undefined || text.trim() === "") return undefined;
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (err) {
    problems.push(`src/content/${name}: does not parse (${err instanceof Error ? err.message : String(err)})`);
    return undefined;
  }
  return data && typeof data === "object" && !Array.isArray(data) && Object.keys(data).length === 0 ? undefined : data;
}
const rawCatalog = optionalJson("products.json");
const rawTerms = optionalJson("blog-terms.json");
const badCatalog = rawCatalog === undefined ? [] : catalogProblems(rawCatalog);
const badTerms = rawTerms === undefined ? [] : blogTermsProblems(rawTerms);
problems.push(...badCatalog, ...badTerms);
if (problems.length === 0 && (rawCatalog !== undefined || rawTerms !== undefined)) {
  // A shop, product, category or blog term path must not be a page, post or the blog list.
  const taken = [
    ...rawPages.map(({ data }) => String((data as ComposedPage).path)),
    ...rawPosts.map(({ data }) => String((data as BlogPost).path)),
    ...(site.blog ? [site.blog.path] : []),
    ...(rawPages.some(({ data }) => normalizePagePath(String((data as ComposedPage).path)) === "/") ? [] : PAGES.map((p) => p.path)),
  ];
  problems.push(...shopPathProblems(rawCatalog as ProductCatalog | undefined, rawTerms as BlogTerms | undefined, taken));
  if (hasShop(rawCatalog as ProductCatalog | undefined)) {
    for (const { pagePath } of formsOf(rawPages.map(({ data }) => data as ComposedPage)).filter(({ form }) => form.name === PRODUCT_ENQUIRY_FORM.name)) {
      problems.push(`form "${PRODUCT_ENQUIRY_FORM.name}" on ${pagePath}: that name belongs to the product pages' enquiry form; rename it`);
    }
  }
}
if (problems.length > 0) {
  throw new Error(`[landing content] ${problems.length} problem(s):\n  - ${problems.join("\n  - ")}`);
}

/**
 * The product catalog of a migrated store (src/content/products.json), or
 * null. lib/shop.ts turns it into the shop list, product and category pages.
 */
export const catalog: ProductCatalog | null = (rawCatalog as ProductCatalog | undefined) ?? null;

/** The blog categories and tags of a migrated blog (src/content/blog-terms.json), or null. */
export const blogTerms: BlogTerms | null = (rawTerms as BlogTerms | undefined) ?? null;

/** The shop, product, category and blog term routes. Empty for a site that sells nothing. */
export const shopPages = shopRoutes(catalog, blogTerms);

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
  for (const r of shopPages) {
    if (r.kind === "product" && r.product.seo?.noindex) continue;
    if (r.kind === "shop" && catalog?.index?.seo?.noindex) continue;
    const label = r.kind === "shop" ? shopTitle() : r.kind === "product" ? r.product.title : r.kind === "category" ? r.category.name : r.term.name;
    list.push({ path: r.path, label });
  }
  return list;
}

/** The shop list's H1: the old shop page's, else "Shop". */
export function shopTitle(): string {
  return catalog?.index?.title?.trim() || "Shop";
}

function generatedNav(): SiteLink[] {
  const links: SiteLink[] = classicPages.filter((p) => p.path !== "/").map((p) => ({ label: p.label, href: p.path }));
  const composed = composedPages
    .filter((p) => p.navLabel && p.path !== "/")
    .sort((a, b) => (a.navOrder ?? 100) - (b.navOrder ?? 100) || a.path.localeCompare(b.path));
  for (const p of composed) links.push({ label: p.navLabel as string, href: p.path });
  if (blog?.navLabel) links.push({ label: blog.navLabel, href: blog.path });
  if (hasShop(catalog)) links.push({ label: catalog.index?.navLabel?.trim() || shopTitle(), href: shopPath(catalog) });
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
