/**
 * The shop of a migrated store, built from src/content/products.json, and
 * the blog category and tag archives, built from src/content/blog-terms.json.
 * Both files are written by `npm run import:site-model`.
 *
 * Products are data, not pages: one template renders the shop list at the
 * catalog's `indexPath` (default "/shop/"), one renders every product at its
 * own (original) `path`, one renders every category that has a `path`. A
 * missing or empty products.json builds no shop routes at all, so a site
 * that sells nothing is unaffected.
 *
 * There is no checkout. A product's buy button links to its `buyUrl` (a
 * store that still takes orders) when it has one, else to the product
 * enquiry form on the same page (PRODUCT_ENQUIRY_FORM, posted to
 * /api/site-forms/product-enquiry).
 *
 * Pure functions only (no Astro, no site.json), so the node tests
 * (scripts/shop.test.mjs) load this file directly.
 */
import type { BlogPost, BlogTerm, BlogTerms, CatalogCategory, CatalogProduct, ProductCatalog } from "./composed.ts";
import { normalizePagePath } from "./composed.ts";

/** The shop list path when products.json does not name one. */
export const DEFAULT_SHOP_PATH = "/shop/";

/** True when the catalog has at least one product, so the shop is built. */
export function hasShop(catalog: ProductCatalog | null | undefined): catalog is ProductCatalog {
  return Boolean(catalog && Array.isArray(catalog.items) && catalog.items.length > 0);
}

/** The shop list path, normalized. */
export function shopPath(catalog: ProductCatalog): string {
  return normalizePagePath(catalog.indexPath || DEFAULT_SHOP_PATH);
}

export type ShopRoute =
  | { kind: "shop"; path: string }
  | { kind: "product"; path: string; product: CatalogProduct }
  | { kind: "category"; path: string; category: CatalogCategory }
  | { kind: "term"; path: string; term: BlogTerm; termKind: "category" | "tag" };

/**
 * Every route the shop and the blog terms add: the shop list, each product,
 * each category with a path, each blog category and tag with a path.
 * Empty when there is nothing to render.
 */
export function shopRoutes(catalog: ProductCatalog | null | undefined, terms: BlogTerms | null | undefined): ShopRoute[] {
  const out: ShopRoute[] = [];
  if (hasShop(catalog)) {
    out.push({ kind: "shop", path: shopPath(catalog) });
    for (const product of catalog.items) {
      const path = normalizePagePath(product.path);
      out.push({ kind: "product", path, product: { ...product, path } });
    }
    for (const category of catalog.categories ?? []) {
      if (!category.path) continue;
      const path = normalizePagePath(category.path);
      out.push({ kind: "category", path, category: { ...category, path } });
    }
  }
  for (const [termKind, list] of [["category", terms?.categories], ["tag", terms?.tags]] as const) {
    for (const term of list ?? []) {
      if (!term.path) continue;
      const path = normalizePagePath(term.path);
      out.push({ kind: "term", path, term: { ...term, path }, termKind });
    }
  }
  return out;
}

/**
 * Problems with the shop and term paths: one used twice, or one that is
 * also a page, a post or the blog list (`taken`). [] means they build.
 */
export function shopPathProblems(
  catalog: ProductCatalog | null | undefined,
  terms: BlogTerms | null | undefined,
  taken: string[],
): string[] {
  const owner = new Map<string, string>(taken.map((p) => [normalizePagePath(p), "a page or post"]));
  const out: string[] = [];
  for (const r of shopRoutes(catalog, terms)) {
    const file = r.kind === "term" ? "src/content/blog-terms.json" : "src/content/products.json";
    const who = r.kind === "shop" ? "the shop list" : r.kind === "product" ? `product "${r.product.slug}"` : r.kind === "category" ? `category "${r.category.slug}"` : `blog ${r.termKind} "${r.term.slug}"`;
    const prior = owner.get(r.path);
    if (prior) out.push(`${file}: path ${r.path} is also ${prior} (${who})`);
    else owner.set(r.path, who);
  }
  return out;
}

/** The products in a category: by the product's category slugs, or the category's productIds. */
export function categoryProducts(catalog: ProductCatalog, category: CatalogCategory): CatalogProduct[] {
  const ids = new Set(category.productIds ?? []);
  return catalog.items.filter((p) => (p.categories ?? []).includes(category.slug) || ids.has(p.id));
}

/** The categories directly under a category. */
export function subcategories(catalog: ProductCatalog, category: CatalogCategory): CatalogCategory[] {
  return (catalog.categories ?? []).filter((c) => c.parentSlug === category.slug);
}

/** A product's categories, in the order the product lists them. */
export function productCategories(catalog: ProductCatalog, product: CatalogProduct): CatalogCategory[] {
  const bySlug = new Map((catalog.categories ?? []).map((c) => [c.slug, c]));
  const out = (product.categories ?? []).map((s) => bySlug.get(s)).filter((c): c is CatalogCategory => Boolean(c));
  for (const c of catalog.categories ?? []) if (!out.includes(c) && (c.productIds ?? []).includes(product.id)) out.push(c);
  return out;
}

/** The blog posts filed under a category or tag. Posts name their terms; the slug matches too. */
export function termPosts(posts: BlogPost[], term: BlogTerm, termKind: "category" | "tag"): BlogPost[] {
  const keys = new Set([term.name, term.slug].map((k) => k.trim().toLowerCase()));
  return posts.filter((p) => ((termKind === "category" ? p.categories : p.tags) ?? []).some((n) => keys.has(n.trim().toLowerCase())));
}

/** "120.00" + "USD" -> "$120.00". An unknown currency code prints "120.00 XYZ". */
export function formatPrice(amount: string | null | undefined, currency: string | null | undefined): string | null {
  if (amount === null || amount === undefined || amount === "") return null;
  const n = Number(amount);
  if (!Number.isFinite(n)) return null;
  if (currency) {
    try {
      return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(n);
    } catch {
      return `${amount} ${currency}`;
    }
  }
  return amount;
}

/** The price a visitor sees: the current price, and the old one when it is on sale. */
export function productPrice(product: CatalogProduct, fallbackCurrency: string | null = null): { current: string | null; was: string | null } {
  const currency = product.currency ?? fallbackCurrency;
  const amount = product.price ?? product.salePrice ?? product.regularPrice;
  const current = formatPrice(amount, currency);
  const was = product.onSale && product.regularPrice && product.regularPrice !== amount ? formatPrice(product.regularPrice, currency) : null;
  return { current, was };
}

/** "In stock", "Out of stock", or null when the old store did not say. */
export function stockLabel(inStock: boolean | null | undefined): string | null {
  return inStock === true ? "In stock" : inStock === false ? "Out of stock" : null;
}

/** Text of an HTML fragment: tags removed, whitespace collapsed. */
export function plainText(html: string | null | undefined): string {
  return (html ?? "")
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

/** One plain sentence or two about a product, for the meta description and JSON-LD. */
export function productSummary(product: CatalogProduct): string {
  const text = product.seo?.description?.trim() || product.shortDescription?.trim() || plainText(product.html);
  return text.length > 300 ? `${text.slice(0, 297).replace(/\s+\S*$/, "")}...` : text;
}

/** The buy action: an external store link, or the enquiry form on the page. */
export function buyAction(product: CatalogProduct): { kind: "store"; href: string; label: string } | { kind: "enquire"; href: string; label: string } {
  if (product.buyUrl && /^https?:\/\//i.test(product.buyUrl)) {
    let host = "";
    try {
      host = new URL(product.buyUrl).host.replace(/^www\./, "");
    } catch {
      // checked by catalogProblems
    }
    return { kind: "store", href: product.buyUrl, label: host ? `Buy on ${host}` : "Buy now" };
  }
  return { kind: "enquire", href: "#form-product-enquiry", label: "Ask about this product" };
}

const AVAILABILITY = { true: "https://schema.org/InStock", false: "https://schema.org/OutOfStock" } as const;

function decimal(v: string | null | undefined): string | null {
  return v !== null && v !== undefined && /^-?\d+(\.\d+)?$/.test(v) ? v : null;
}

export interface ProductLdOptions {
  /** site.json url; without it no absolute URLs are printed. */
  siteUrl?: string | null;
  siteName: string;
  /** The page's visible Published and Updated dates. */
  published: string;
  updated: string;
  fallbackCurrency?: string | null;
}

function absolute(siteUrl: string | null | undefined, pathOrUrl: string): string {
  if (/^https?:\/\//i.test(pathOrUrl) || !siteUrl) return pathOrUrl;
  return `${siteUrl.replace(/\/+$/, "")}${pathOrUrl.startsWith("/") ? "" : "/"}${pathOrUrl}`;
}

/**
 * The JSON-LD graph for one product page: the dated ItemPage first (its
 * dates are the page's visible dates, for the AEO date rule), then the
 * schema.org Product with an Offer (or an AggregateOffer when the variants
 * have different prices), then the Organization. Every value is one the
 * page shows.
 */
export function productLd(product: CatalogProduct, catalog: ProductCatalog, opts: ProductLdOptions): object {
  const url = opts.siteUrl ? absolute(opts.siteUrl, normalizePagePath(product.path)) : null;
  const currency = product.currency ?? catalog.currency ?? opts.fallbackCurrency ?? null;
  const page: Record<string, unknown> = {
    "@type": "ItemPage",
    name: product.seo?.title?.trim() || product.title,
    datePublished: opts.published,
    dateModified: opts.updated,
    mainEntity: { "@id": "#product" },
    publisher: { "@id": "#organization" },
  };
  if (url) page.url = url;

  const item: Record<string, unknown> = { "@type": "Product", "@id": "#product", name: product.title };
  const summary = productSummary(product);
  if (summary) item.description = summary;
  if (product.sku) item.sku = product.sku;
  if (product.images?.length) item.image = product.images.map((src) => absolute(opts.siteUrl, src));
  if (url) item.url = url;
  if (product.vendor) item.brand = { "@type": "Brand", name: product.vendor };
  const cats = productCategories(catalog, product).map((c) => c.name);
  if (cats.length > 0) item.category = cats.join(", ");

  const availability = product.inStock === true || product.inStock === false ? AVAILABILITY[String(product.inStock) as "true" | "false"] : null;
  const variantPrices = (product.variants ?? []).map((v) => decimal(v.price)).filter((p): p is string => p !== null);
  const distinct = [...new Set(variantPrices.map(Number))];
  if (currency && distinct.length > 1) {
    const offer: Record<string, unknown> = {
      "@type": "AggregateOffer",
      priceCurrency: currency,
      lowPrice: String(Math.min(...distinct)),
      highPrice: String(Math.max(...distinct)),
      offerCount: variantPrices.length,
    };
    if (availability) offer.availability = availability;
    item.offers = offer;
  } else {
    const price = decimal(product.price) ?? decimal(product.salePrice) ?? decimal(product.regularPrice) ?? variantPrices[0] ?? null;
    if (price && currency) {
      const offer: Record<string, unknown> = { "@type": "Offer", price, priceCurrency: currency, seller: { "@id": "#organization" } };
      if (availability) offer.availability = availability;
      if (url) offer.url = url;
      item.offers = offer;
    }
  }

  const org: Record<string, unknown> = { "@type": "Organization", "@id": "#organization", name: opts.siteName };
  if (opts.siteUrl) org.url = opts.siteUrl;
  return { "@context": "https://schema.org", "@graph": [page, item, org] };
}

function isProductNode(node: unknown): boolean {
  const t = (node as { "@type"?: unknown })?.["@type"];
  return t === "Product" || (Array.isArray(t) && t.includes("Product"));
}

/** Carried JSON-LD without Product nodes: the page prints its own Product, built from products.json. */
export function withoutProductLd(items: object[]): object[] {
  return items.flatMap((item) => {
    if (isProductNode(item)) return [];
    const graph = (item as { "@graph"?: unknown })["@graph"];
    if (Array.isArray(graph)) return [{ ...item, "@graph": graph.filter((n) => !isProductNode(n)) }];
    return [item];
  });
}

/** The archive path of the blog category or tag a post names, when it has one. */
export function termHref(terms: BlogTerms | null | undefined, termKind: "category" | "tag", name: string): string | null {
  const key = name.trim().toLowerCase();
  const list = (termKind === "category" ? terms?.categories : terms?.tags) ?? [];
  const term = list.find((t) => t.path && (t.name.trim().toLowerCase() === key || t.slug.trim().toLowerCase() === key));
  return term?.path ? normalizePagePath(term.path) : null;
}
