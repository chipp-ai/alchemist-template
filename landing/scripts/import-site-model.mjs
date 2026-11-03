#!/usr/bin/env node
// Import a migrated site's model into the landing content files.
//
// Chipp crawls the builder's old site, reads its platform's public API
// (WordPress REST, WooCommerce Store API, Shopify and Squarespace JSON) and
// commits chipp/site-migration/: site-model.json (the SiteModel, whose
// contract is siteModelSchema in chipp-deno src/alchemist/lib/site-model.ts),
// old-urls.json, the cleaned HTML of each crawled page under pages/, and the
// HTML of every API page, post and product under content/<kind>-NNN.json
// ({ "items": { "<path>": "<html>" } }). This script copies the parts that
// must not be retyped by hand, exactly as the old site had them:
//
//   - src/content/pages/<name>.json: one per page at the same path, with the
//     title, description, canonical, Open Graph and JSON-LD, the page body
//     from content/ as one richText section, and a form section for every
//     form on the page (same name, posting to /api/site-forms/<name>)
//   - src/content/posts/<name>.json: one per blog post at its old path, with
//     its date, author, featured image, categories, tags, SEO and body
//   - src/content/products.json: the product catalog (products and product
//     categories) with prices, currency, stock, images, attributes and paths
//   - src/content/blog-terms.json: blog categories and tags with their paths
//   - site.json "blog" (the list page) and "nav" (the old header and footer
//     links), only when site.json does not have them yet
//
// Every old asset URL becomes its rehosted URL (assets.map), and links to
// the old origin become site paths. It never invents words: a page with no
// body gets no sections, and the build then fails until the page is rebuilt
// from its screenshot. Everything it could not place is reported with the
// reason. Existing files are kept unless --force is given. It never writes
// chipp/redirects.json. Models written before 2026-11-02 (and the early
// draft shape with `assets[].oldUrl` and `collections` as a list) import too.
//
// Usage (from landing/): npm run import:site-model [-- --force]

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { FORM_FIELD_TYPES, normalizePagePath, pagePathProblems, sectionProblems } from "../src/lib/composed.ts";

export const MODEL_PATH = "chipp/site-migration/site-model.json";
export const OLD_URLS_PATH = "chipp/site-migration/old-urls.json";
export const CONTENT_DIR = "chipp/site-migration/content";

const FIELD_TYPE_ALIASES = {
  textarea: "textarea",
  message: "textarea",
  phone: "tel",
  telephone: "tel",
  dropdown: "select",
  "select-one": "select",
  radio: "radio",
  checkbox: "checkbox",
  "datetime-local": "date",
};
const FIELD_NAME_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const FORM_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}/;
/** Platform cart, checkout and account pages. The rebuild never copies a checkout. */
const COMMERCE_PATH_RE = /^\/(cart|basket|checkout|my-account|account|wishlist|order-tracking)(\/|$)/i;
/** Old-origin URLs that point at files. They stay absolute: a site path to them would 404. */
const FILE_EXT_RE = /\.(jpe?g|png|gif|webp|avif|svg|ico|bmp|tiff?|pdf|docx?|xlsx?|pptx?|zip|mp[34]|mov|webm|m4a|wav|woff2?|ttf|otf|css|js)$/i;
const PLATFORM_NAMES = {
  wordpress: "WordPress",
  shopify: "Shopify",
  squarespace: "Squarespace",
  wix: "Wix",
  webflow: "Webflow",
  framer: "Framer",
  lovable: "Lovable",
  unknown: "an unknown platform",
};

// ── Small helpers ──

const isObj = (v) => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const arr = (v) => (Array.isArray(v) ? v : []);
const text = (v) => (typeof v === "string" && v.trim() ? v.trim() : undefined);

function slugify(value, fallback) {
  const s = String(value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
  return s || fallback;
}

/** "/" -> "home", "/services/roofing/" -> "services--roofing". */
export function fileNameForPath(path) {
  const p = normalizePagePath(path).replace(/^\/|\/$/g, "");
  return p === "" ? "home" : p.split("/").map((seg) => slugify(seg, "page")).join("--");
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Deep-map every string in a JSON value. */
function mapStrings(value, fn) {
  if (typeof value === "string") return fn(value);
  if (Array.isArray(value)) return value.map((v) => mapStrings(v, fn));
  if (isObj(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, mapStrings(v, fn)]));
  return value;
}

function stripTags(html) {
  return String(html ?? "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#8217;|&rsquo;/g, "\u2019")
    .replace(/&#8230;|&hellip;/g, "\u2026")
    .replace(/\s+/g, " ")
    .trim();
}

function isoDate(v) {
  return typeof v === "string" && ISO_DATE_RE.test(v) ? v.slice(0, 10) : undefined;
}

/** True when the item is published (no status means published). */
const isLive = (item) => !item?.status || item.status === "publish";

/** A list of report lines, shortened for the terminal. */
function sample(list, n = 3) {
  return list.slice(0, n).join(", ") + (list.length > n ? `, and ${list.length - n} more` : "");
}

// ── Assets and links ──

/** Old URL -> rehosted URL, from `assets.map` (and `assets.items`), or the early `assets[]` list. */
export function assetMapOf(model) {
  const map = new Map();
  const assets = model?.assets;
  if (Array.isArray(assets)) {
    for (const a of assets) if (text(a?.oldUrl) && text(a?.newUrl)) map.set(a.oldUrl, a.newUrl);
  } else if (isObj(assets)) {
    for (const a of arr(assets.items)) if (text(a?.originalUrl) && text(a?.url)) map.set(a.originalUrl, a.url);
    if (isObj(assets.map)) for (const [k, v] of Object.entries(assets.map)) if (k && text(v)) map.set(k, v);
  }
  return map;
}

/**
 * The string rewriter for one model: rehosted assets first (longest old URL
 * first, so a prefix never wins), then old-origin URLs to site paths. A file
 * URL on the old origin (an image the platform did not rehost) stays
 * absolute and is listed in `leftOnOldSite`.
 */
export function makeRewriter(model) {
  const assets = [...assetMapOf(model).entries()].sort((a, b) => b[0].length - a[0].length);
  const origin = typeof model?.meta?.origin === "string" ? model.meta.origin.replace(/\/+$/, "") : "";
  const leftOnOldSite = new Set();
  let originRe = null;
  if (origin) {
    let host = "";
    try {
      host = new URL(origin).host.replace(/^www\./, "");
    } catch {
      host = "";
    }
    if (host) originRe = new RegExp(`https?://(?:www\\.)?${escapeRegExp(host)}(?=[/"'\\s<>?#]|$)(/[^"'\\s<>]*)?`, "g");
  }
  const assetsOnly = (s) => (s.includes("://") ? assets.reduce((acc, [from, to]) => (acc.includes(from) ? acc.split(from).join(to) : acc), s) : s);
  const toSite = (s, replace) =>
    originRe
      ? s.replace(originRe, (m, path) => {
        const bare = (path ?? "").split(/[?#]/, 1)[0];
        if (FILE_EXT_RE.test(bare)) {
          leftOnOldSite.add(m);
          return m;
        }
        return replace(path || "/", m);
      })
      : s;
  return {
    /** Assets rehosted, old-origin links made site-relative. */
    content: (s) => toSite(assetsOnly(s), (path) => path),
    /** Assets rehosted, old origin swapped for the new site URL when known (JSON-LD, Open Graph). */
    structured: (s, siteUrl) =>
      toSite(assetsOnly(s), (path, original) => (siteUrl ? `${siteUrl.replace(/\/+$/, "")}${path}` : original)),
    /** One URL: the rehosted copy when there is one. */
    asset: (s) => assetsOnly(s),
    leftOnOldSite,
  };
}

function toLinks(list) {
  const out = arr(list)
    .map((l) => ({ label: text(l?.label ?? l?.text ?? l?.title), href: text(l?.href ?? l?.url) }))
    .filter((l) => l.label && l.href);
  return out.length > 0 ? out : undefined;
}

/** Top-level items of the first logged-in menu at a location matching `re`. */
function menuLinks(menus, re) {
  const menu = arr(menus).find((m) => arr(m?.locations).some((l) => re.test(String(l))));
  if (!menu) return undefined;
  const items = arr(menu.items)
    .filter((i) => !i?.parentId)
    .sort((a, b) => (a?.order ?? 0) - (b?.order ?? 0));
  return toLinks(items);
}

// ── SEO ──

/**
 * One SEO record from any of the model's shapes: a crawled page's
 * `seo` (ogTitle, ogImage, robots, jsonLd, h1), an API item's imported
 * `seo` (title, description, canonical, robots, ogImage, jsonLd), or the
 * early draft's `seo.og` object.
 */
function readSeo(seo) {
  if (!isObj(seo)) return {};
  const og = {};
  if (isObj(seo.og)) {
    for (const [k, v] of Object.entries(seo.og)) if (typeof v === "string" && v) og[k.replace(/^og:/, "")] = v;
  }
  for (const [key, field] of [["title", "ogTitle"], ["description", "ogDescription"], ["image", "ogImage"], ["type", "ogType"]]) {
    if (text(seo[field]) && !og[key]) og[key] = seo[field].trim();
  }
  const robots = text(seo.robots) ?? "";
  let jsonLd = [];
  if (Array.isArray(seo.jsonLd)) jsonLd = seo.jsonLd.filter(isObj);
  else if (isObj(seo.jsonLd)) jsonLd = [seo.jsonLd];
  return {
    title: text(seo.title),
    description: text(seo.description),
    canonical: text(seo.canonical),
    og,
    jsonLd,
    noindex: seo.noindex === true || /\bnoindex\b/i.test(robots),
    h1: text(seo.h1),
  };
}

/** A page's SEO (the crawled head first, the API's SEO as the fallback) and its title. */
function pageSeo(crawled, api) {
  const crawledSeo = readSeo(crawled?.seo);
  const seo = mergeSeo({ ...crawledSeo, title: crawledSeo.title ?? text(crawled?.title) }, readSeo(api?.seo));
  return { seo, title: text(api?.title) ?? seo.h1 ?? text(crawled?.title) ?? seo.title };
}

/** Merge SEO records, first one wins per field. JSON-LD comes from the first record that has any. */
function mergeSeo(...records) {
  const out = { og: {}, jsonLd: [], noindex: false };
  for (const r of records) {
    if (!r) continue;
    for (const k of ["title", "description", "canonical", "h1"]) if (!out[k] && r[k]) out[k] = r[k];
    for (const [k, v] of Object.entries(r.og ?? {})) if (!out.og[k]) out.og[k] = v;
    if (out.jsonLd.length === 0 && r.jsonLd?.length) out.jsonLd = r.jsonLd;
    if (r.noindex) out.noindex = true;
  }
  return out;
}

/** A merged SEO record as the template's PageSeo, URLs rewritten. */
function templateSeo(s, rw, siteUrl) {
  const seo = {};
  if (s.title) seo.title = s.title;
  if (s.description) seo.description = s.description;
  if (s.canonical) seo.canonical = rw.content(s.canonical);
  const og = Object.fromEntries(Object.entries(s.og ?? {}).map(([k, v]) => [k, rw.structured(v, siteUrl)]));
  if (Object.keys(og).length > 0) seo.og = og;
  if (s.jsonLd?.length) seo.jsonLd = mapStrings(s.jsonLd, (v) => rw.structured(v, siteUrl));
  if (s.noindex) seo.noindex = true;
  return seo;
}

// ── Forms ──

/** A SiteModel form as a template form, plus notes about what changed. Null when no field is left. */
export function convertForm(form, usedNames = new Set()) {
  const notes = [];
  let name = String(form?.name ?? "");
  if (!FORM_NAME_RE.test(name)) name = slugify(name, "form");
  const base = name;
  for (let n = 2; usedNames.has(name); n++) name = `${base}-${n}`.slice(0, 64);
  if (name !== form?.name) notes.push(`form "${form?.name}" is named "${name}" (form names are lowercase slugs, unique across the site)`);
  usedNames.add(name);
  const used = new Set();
  const fields = [];
  for (const [i, f] of arr(form?.fields).entries()) {
    const raw = String(f?.type ?? "text").toLowerCase();
    const original = String(f?.name ?? "");
    if (raw === "password") {
      notes.push(`form "${name}" field "${original}": password fields are not imported`);
      continue;
    }
    if (raw === "file") {
      notes.push(`form "${name}" field "${original}": file uploads are not supported by site forms; the field was left out`);
      continue;
    }
    if (raw === "hidden" && original.startsWith("_")) continue; // platform plumbing (_wpnonce, _wpcf7, ...)
    let fieldName = original.replace(/[^A-Za-z0-9_-]/g, "_").replace(/^[^A-Za-z]+/, "").slice(0, 64);
    if (!fieldName) fieldName = `field_${i + 1}`;
    while (used.has(fieldName)) fieldName = `${fieldName.slice(0, 58)}_${i + 1}`;
    used.add(fieldName);
    const options = Array.isArray(f?.options)
      ? f.options.map((o) => (typeof o === "string" ? o : o?.label ?? o?.value)).filter((o) => typeof o === "string" && o.trim())
      : undefined;
    let type = FORM_FIELD_TYPES.includes(raw) ? raw : FIELD_TYPE_ALIASES[raw];
    if (type === "checkbox" && options && options.length > 1) type = "checkboxes";
    if (["select", "radio", "checkboxes"].includes(type) && !options?.length) {
      notes.push(`form "${name}" field "${fieldName}": a ${type} without options; imported as a text field`);
      type = "text";
    }
    if (!type) {
      notes.push(`form "${name}" field "${fieldName}": type "${raw}" is not supported; imported as a text field`);
      type = "text";
    }
    const label = text(f?.label) ?? text(f?.placeholder);
    const field = { name: fieldName, label: label ?? fieldName, type };
    if (!label && type !== "hidden") notes.push(`form "${name}" field "${fieldName}": the old field had no label; check the label`);
    if (f?.required === true) field.required = true;
    if (options && ["select", "radio", "checkboxes"].includes(type)) field.options = options;
    if (type === "hidden") field.value = typeof f?.value === "string" ? f.value : "";
    if (text(f?.placeholder)) field.placeholder = f.placeholder.trim();
    fields.push(field);
  }
  if (fields.length === 0) return { form: null, notes };
  const out = { name, fields };
  if (text(form?.submitLabel)) out.submitLabel = form.submitLabel.trim();
  const target = text(form?.provider) ?? text(form?.action);
  if (target) notes.push(`form "${name}" posted to ${target}; it now posts to /api/site-forms/${name}`);
  return { form: out, notes };
}

// ── The model, read from any of its shapes ──

/** The blog: `collections.blog` (current), or the early draft's `collections` list. */
function readBlog(model) {
  const c = model?.collections;
  if (Array.isArray(c)) {
    const col = c.find((x) => x?.type === "blog" || x?.type === "posts") ??
      c.find((x) => arr(x?.items).some((i) => typeof i?.html === "string"));
    if (!col) return { indexPath: null, posts: [], categories: [], tags: [], legacy: true };
    return {
      indexPath: text(col.path) ?? "/blog/",
      title: text(col.title),
      description: text(col.description),
      posts: arr(col.items).map((i) => ({
        ...i,
        path: i?.path ?? (i?.url ? safePathname(i.url) : null) ?? `${normalizePagePath(col.path ?? "/blog/")}${slugify(i?.slug, "post")}/`,
        publishedAt: i?.publishedAt ?? i?.date ?? null,
        excerpt: i?.excerpt ?? i?.description ?? null,
      })),
      categories: [],
      tags: [],
      legacy: true,
    };
  }
  const blog = isObj(c?.blog) ? c.blog : {};
  return {
    indexPath: text(blog.indexPath) ?? null,
    posts: arr(blog.posts),
    categories: arr(blog.categories),
    tags: arr(blog.tags),
  };
}

function safePathname(url) {
  try {
    return new URL(url).pathname;
  } catch {
    return null;
  }
}

/**
 * Reads item HTML from the content files. `readFile(repoPath)` returns the
 * parsed JSON or throws. Returns `{ html }` or `{ problem }`.
 */
export function makeContentReader(readFile) {
  const cache = new Map();
  return (contentFile, path) => {
    if (!text(contentFile)) return { problem: "no body HTML in the model" };
    const repoPath = contentFile.includes("/") ? contentFile : `${CONTENT_DIR}/${contentFile}`;
    if (!repoPath.startsWith(`${CONTENT_DIR}/`) || repoPath.split("/").includes("..")) {
      return { problem: `content file ${contentFile} is outside ${CONTENT_DIR}/` };
    }
    if (!cache.has(repoPath)) {
      try {
        const file = readFile(repoPath);
        cache.set(repoPath, isObj(file?.items) ? file.items : { __error: "has no items" });
      } catch (err) {
        cache.set(repoPath, { __error: err?.code === "ENOENT" ? "is missing" : `could not be read (${err?.message ?? err})` });
      }
    }
    const items = cache.get(repoPath);
    if (items.__error) return { problem: `content file ${repoPath} ${items.__error}` };
    const html = items[path] ?? items[normalizePagePath(path)] ?? items[normalizePagePath(path).replace(/\/$/, "")];
    return typeof html === "string" && html.trim() ? { html } : { problem: `${repoPath} has no HTML for ${path}` };
  };
}

// ── The plan ──

/**
 * Turn a SiteModel into landing content. Pure: returns the files to write
 * and a report; `importSiteModel` writes them.
 *
 * @param model the parsed site-model.json
 * @param site the parsed landing/src/content/site.json
 * @param opts.readContent `(contentFile, path) => { html } | { problem }` (see makeContentReader)
 * @param opts.oldUrls the parsed old-urls.json, for the "no page yet" list
 * @param opts.redirects the parsed chipp/redirects.json
 */
export function planImport(model, site = {}, opts = {}) {
  const readContent = opts.readContent ?? (() => ({ problem: "no content files were read" }));
  const rw = makeRewriter(model);
  const meta = isObj(model?.meta) ? model.meta : {};
  const origin = String(meta.origin ?? "").replace(/\/+$/, "");
  const siteUrl = text(site.url);
  const report = {
    platform: null,
    counts: {
      pages: 0,
      posts: 0,
      forms: 0,
      headerLinks: 0,
      footerLinks: 0,
      products: 0,
      productCategories: 0,
      blogCategories: 0,
      blogTags: 0,
    },
    written: [],
    kept: [],
    skipped: [],
    todo: [],
    notes: [],
  };
  const skip = (what, reason) => report.skipped.push(`${what}: ${reason}`);
  const fromOld = (path, url) => text(url) ?? `${origin}${path}`;

  // Platform.
  const platform = text(meta.platform) ?? "unknown";
  const pName = PLATFORM_NAMES[platform] ?? platform;
  report.platform = {
    platform,
    confidence: text(meta.platformConfidence) ?? null,
    signals: arr(meta.platformSignals).map(String),
    sources: arr(meta.platformImport?.sources).map(String),
  };
  const imp = isObj(meta.platformImport) ? meta.platformImport : null;
  if (imp) {
    for (const n of arr(imp.notes)) report.notes.push(`${pName}: ${n}`);
    for (const n of arr(imp.needsLogin)) report.notes.push(`needs the owner's login: ${n}`);
    if (imp.capped) report.notes.push(`the platform import stopped at its limit of ${imp.itemCap ?? "?"} items: the old site has more`);
  }
  for (const w of arr(model?.warnings)) report.notes.push(String(w));
  for (const s of arr(model?.skippedPages)) skip(`crawl ${s?.url}`, String(s?.reason ?? "skipped"));
  const skippedAssets = Array.isArray(model?.assets) ? [] : arr(model?.assets?.skipped);
  if (skippedAssets.length > 0) {
    const reasons = {};
    for (const a of skippedAssets) reasons[a?.reason ?? "unknown"] = (reasons[a?.reason ?? "unknown"] ?? 0) + 1;
    report.notes.push(
      `${skippedAssets.length} image(s) were not rehosted (${Object.entries(reasons).map(([r, n]) => `${n} ${r}`).join(", ")}); they still load from the old site`,
    );
  }

  // Collections.
  const blogIn = readBlog(model);
  const blogPath = blogIn.indexPath ? normalizePagePath(blogIn.indexPath) : null;
  const productsIn = isObj(model?.collections) && isObj(model.collections.products) ? model.collections.products : null;
  const productItems = arr(productsIn?.items);
  const productCats = arr(productsIn?.categories);
  const shopPath = text(productsIn?.indexPath) ? normalizePagePath(productsIn.indexPath) : null;
  const hasShop = productItems.length > 0 || productCats.length > 0;
  const productPaths = new Set([
    ...productItems.map((p) => (text(p?.path) ? normalizePagePath(p.path) : null)),
    ...productCats.map((c) => (text(c?.path) ? normalizePagePath(c.path) : null)),
  ].filter(Boolean));
  const postPaths = new Set(blogIn.posts.filter(isLive).map((p) => (text(p?.path) ? normalizePagePath(p.path) : null)).filter(Boolean));

  // Crawled pages and API pages, merged by path.
  const byPath = new Map();
  for (const raw of arr(model?.pages)) {
    if (!text(raw?.path)) continue;
    const path = normalizePagePath(raw.path);
    if (!byPath.has(path)) byPath.set(path, { path, crawled: raw });
  }
  const apiPages = isObj(model?.collections) ? arr(model.collections.pages) : [];
  for (const raw of apiPages) {
    if (!text(raw?.path)) continue;
    const path = normalizePagePath(raw.path);
    const entry = byPath.get(path) ?? { path };
    if (!entry.api) entry.api = raw;
    byPath.set(path, entry);
  }

  const pages = [];
  const blogListPages = [];
  const outline = [];
  const rebuild = [];
  const noScreenshot = [];
  const noBody = [];
  for (const { path, crawled, api } of byPath.values()) {
    const kind = crawled?.kind;
    if (path === blogPath || kind === "blog_index") {
      blogListPages.push(path); // the blog list, built from the posts
      continue;
    }
    if (kind === "blog_post" || postPaths.has(path)) {
      if (!postPaths.has(path)) skip(`page ${path}`, "a crawled blog post the model has no post entry for; rebuild it as a post");
      continue;
    }
    if (api && !isLive(api)) {
      skip(`page ${path}`, `${api.status}: it never had a public address`);
      continue;
    }
    if (hasShop && path === shopPath) {
      skip(`page ${path}`, "the shop list: the shop pages render it from products.json");
      continue;
    }
    if (productPaths.has(path)) {
      skip(`page ${path}`, "a product or product category path: the shop pages render it from products.json");
      continue;
    }
    if (hasShop && COMMERCE_PATH_RE.test(path)) {
      skip(`page ${path}`, `the old ${pName} cart, checkout or account page: never copied; add a 301 or a page for it`);
      continue;
    }
    const pathProblem = pagePathProblems(path)[0];
    if (pathProblem) {
      skip(`page ${path}`, `${pathProblem.replace(/^"path" /, "")}`);
      continue;
    }

    const { seo, title: heading } = pageSeo(crawled, api);
    const title = heading ?? path;
    const sections = [];
    for (const [i, s] of arr(crawled?.sections).entries()) {
      if (isObj(s) && s.kind && !s.type) {
        outline.push(`${path}: ${s.kind}${text(s.heading) ? ` "${s.heading.trim()}"` : ""}`);
        continue;
      }
      const mapped = mapStrings(s, rw.content);
      const problems = sectionProblems(mapped, `${path} sections[${i}]`);
      if (problems.length === 0) sections.push(mapped);
      else skip(`section ${path} sections[${i}] (${s?.type ?? "no type"})`, problems[0]);
    }
    let body = null;
    if (sections.length === 0 && api) {
      const got = readContent(api.contentFile, api.path);
      if (got.html) body = rw.content(got.html);
      else if (text(api.contentFile)) skip(`page body ${path}`, got.problem);
    }
    if (body) sections.push({ type: "richText", heading: seo.h1 ?? title, html: body });

    const page = {
      path,
      title,
      seo: templateSeo(seo, rw, siteUrl),
      importedFrom: fromOld(path, crawled?.source?.url),
      sections,
    };
    const published = isoDate(api?.publishedAt);
    const updated = isoDate(api?.updatedAt) ?? published;
    if (published) page.publishedAt = published;
    if (updated) page.updatedAt = updated;
    pages.push(page);

    const shot = crawled?.screenshot?.desktop ?? crawled?.screenshot?.mobile;
    if (sections.length === 0) noBody.push(`${path} (${shot ?? crawled?.source?.html ?? "the old page"})`);
    else if (body && shot) rebuild.push(`${path} (${shot})`);
    else if (body) noScreenshot.push(path);
  }
  report.counts.pages = pages.length;
  if (noBody.length > 0) {
    report.todo.push(`${noBody.length} page(s) have no body: rebuild each from its screenshot (the build fails until then): ${sample(noBody, 5)}`);
  }
  if (rebuild.length > 0) {
    report.todo.push(`${rebuild.length} page(s) hold the old body as one richText section: rebuild each in sections, in the order its screenshot shows: ${sample(rebuild, 5)}`);
  }
  if (noScreenshot.length > 0) {
    report.todo.push(`${noScreenshot.length} page(s) came from the ${pName} API with no screenshot: give each the layout of the closest screenshotted page: ${sample(noScreenshot, 5)}`);
  }
  if (outline.length > 0) report.notes.push(`the crawl outlined ${outline.length} section(s) by kind only (no content): ${sample(outline, 5)}`);

  // Forms.
  const formNames = new Set();
  for (const f of arr(model?.forms)) {
    const { form, notes } = convertForm(f, formNames);
    report.notes.push(...notes);
    const where = text(f?.pagePath) ? normalizePagePath(f.pagePath) : null;
    if (!form) {
      skip(`form "${f?.name}" on ${where ?? "no page"}`, "no field the site forms can take");
      continue;
    }
    const target = where ? pages.find((p) => p.path === where) : undefined;
    if (!target) {
      skip(`form "${form.name}"`, `its page ${where ?? "(none)"} was not imported as a page; place it by hand`);
      continue;
    }
    target.sections.push({ type: "form", form });
    report.counts.forms++;
  }

  // Blog posts.
  const termName = (list) => {
    const m = new Map(arr(list).map((t) => [t?.slug, text(t?.name) ?? t?.slug]));
    return (slug) => m.get(slug) ?? slug;
  };
  const catName = termName(blogIn.categories);
  const tagName = termName(blogIn.tags);
  const crawledByPath = new Map(arr(model?.pages).filter((p) => text(p?.path)).map((p) => [normalizePagePath(p.path), p]));
  const posts = [];
  const pagePaths = new Set(pages.map((p) => p.path));
  for (const item of blogIn.posts) {
    if (!text(item?.path)) {
      skip(`post "${item?.title ?? "?"}"`, "no path");
      continue;
    }
    if (!isLive(item)) {
      skip(`post ${item.path} ("${item.title ?? ""}")`, `${item.status}: it never had a public address`);
      continue;
    }
    const path = normalizePagePath(item.path);
    const pathProblem = pagePathProblems(path)[0];
    if (pathProblem) {
      skip(`post ${path}`, pathProblem.replace(/^"path" /, ""));
      continue;
    }
    if (pagePaths.has(path) || path === blogPath) {
      skip(`post ${path}`, "a page already has this path");
      continue;
    }
    const crawled = crawledByPath.get(path);
    let html = typeof item.html === "string" && item.html.trim() ? item.html : null;
    if (!html) {
      const got = readContent(item.contentFile, item.path);
      if (got.html) html = got.html;
      else {
        const shot = crawled?.screenshot?.desktop ?? crawled?.source?.html;
        skip(`post ${path}`, `${got.problem}; rebuild it from ${shot ?? "the old post"}`);
        continue;
      }
    }
    const title = text(item.title) ?? text(crawled?.title);
    const date = isoDate(item.publishedAt) ?? isoDate(item.updatedAt);
    if (!title || !date) {
      skip(`post ${path}`, !title ? "no title" : "no publish date in the model; add the date from the old post");
      continue;
    }
    const seo = mergeSeo(readSeo(item.seo), readSeo(crawled?.seo));
    const post = { path, title, date, html: rw.content(html), importedFrom: fromOld(path, crawled?.source?.url) };
    const updated = isoDate(item.updatedAt);
    if (updated && updated !== date) post.updatedAt = updated;
    if (text(item.author)) post.author = item.author.trim();
    const description = text(item.excerpt) ? stripTags(item.excerpt) : seo.description;
    if (description) post.description = description;
    const image = typeof item.image === "string" ? text(item.image) : text(item.image?.src);
    if (image) post.image = { src: rw.asset(image), alt: typeof item.image?.alt === "string" ? item.image.alt : "" };
    const categories = arr(item.categories).filter((c) => typeof c === "string" && c).map(catName);
    const tags = arr(item.tags).filter((c) => typeof c === "string" && c).map(tagName);
    if (categories.length > 0) post.categories = categories;
    if (tags.length > 0) post.tags = tags;
    const postSeo = templateSeo(seo, rw, siteUrl);
    if (Object.keys(postSeo).length > 0) post.seo = postSeo;
    posts.push(post);
  }
  report.counts.posts = posts.length;

  let blog = null;
  if (posts.length > 0 || (blogPath && blogIn.legacy)) {
    if (!blogPath) {
      report.todo.push(`${posts.length} post(s) need a blog list path: set "blog" in site.json ({ "path", "title", "description" }) from the old blog page`);
    } else {
      const listCrawled = crawledByPath.get(blogPath);
      const listApi = apiPages.find((p) => text(p?.path) && normalizePagePath(p.path) === blogPath);
      const listSeo = mergeSeo(readSeo(listCrawled?.seo), readSeo(listApi?.seo));
      blog = {
        path: blogPath,
        title: text(blogIn.title) ?? listSeo.title ?? text(listCrawled?.title) ?? text(listApi?.title) ?? "",
        description: text(blogIn.description) ?? listSeo.description ?? (text(listApi?.excerpt) ? stripTags(listApi.excerpt) : "") ?? "",
      };
      if (!blog.title || !blog.description) {
        report.todo.push(`site.json blog: fill "title" and "description" from the old blog page ${blogPath}`);
      }
    }
  }

  for (const path of blogListPages) {
    if (blog?.path !== path) skip(`page ${path}`, "a blog list page, but no blog list is built here (no post was imported); rebuild it or add a 301");
  }

  const blogTerms = blogIn.categories.length > 0 || blogIn.tags.length > 0
    ? {
      importedFrom: origin,
      categories: blogIn.categories.map(term),
      tags: blogIn.tags.map(term),
    }
    : null;
  report.counts.blogCategories = blogIn.categories.length;
  report.counts.blogTags = blogIn.tags.length;
  const catPaths = blogIn.categories.map((t) => t?.path).filter(text);
  if (catPaths.length > 0) {
    report.notes.push(`${catPaths.length} blog category page(s) from blog-terms.json are rendered at their old paths: ${sample(catPaths)}`);
  }

  // Products.
  let catalog = null;
  if (hasShop) {
    const taken = new Set([...pages.map((p) => p.path), ...posts.map((p) => p.path), ...(blog ? [blog.path] : [])]);
    const currency = text(productsIn.currency) ?? null;
    const items = [];
    let withoutBody = 0;
    for (const p of productItems) {
      if (!text(p?.path)) {
        skip(`product "${p?.title ?? p?.id}"`, "no path");
        continue;
      }
      const path = normalizePagePath(p.path);
      const pathProblem = pagePathProblems(path)[0];
      if (pathProblem) {
        skip(`product ${path}`, pathProblem.replace(/^"path" /, ""));
        continue;
      }
      if (taken.has(path)) {
        skip(`product ${path}`, "a page, post or another product already has this path");
        continue;
      }
      if (!text(p.title)) {
        skip(`product ${path}`, "no title");
        continue;
      }
      taken.add(path);
      const got = readContent(p.contentFile, p.path);
      if (!got.html) withoutBody++;
      if (!got.html && text(p.contentFile)) skip(`product body ${path}`, got.problem);
      const seo = templateSeo(mergeSeo(readSeo(p.seo)), rw, siteUrl);
      items.push({
        id: String(p.id ?? ""),
        slug: text(p.slug) ?? path.split("/").filter(Boolean).pop() ?? "",
        path,
        title: p.title.trim(),
        sku: p.sku ?? null,
        price: p.price ?? null,
        regularPrice: p.regularPrice ?? null,
        salePrice: p.salePrice ?? null,
        currency: text(p.currency) ?? currency,
        onSale: p.onSale === true,
        inStock: typeof p.inStock === "boolean" ? p.inStock : null,
        shortDescription: text(p.shortDescription) ?? null,
        html: got.html ? rw.content(got.html) : null,
        images: arr(p.images).filter(text).map(rw.asset),
        categories: arr(p.categories).filter(text),
        tags: arr(p.tags).filter(text),
        vendor: text(p.vendor) ?? null,
        variants: arr(p.variants).map((v) => ({
          id: String(v?.id ?? ""),
          title: String(v?.title ?? ""),
          sku: v?.sku ?? null,
          price: v?.price ?? null,
          available: typeof v?.available === "boolean" ? v.available : null,
        })),
        attributes: arr(p.attributes)
          .filter((a) => text(a?.name))
          .map((a) => ({ name: a.name.trim(), values: arr(a.values).filter((v) => typeof v === "string") })),
        ...(Object.keys(seo).length > 0 ? { seo } : {}),
        importedFrom: fromOld(path),
      });
    }
    const categories = [];
    for (const c of productCats) {
      if (!text(c?.slug) || !text(c?.name)) {
        skip(`product category ${c?.id ?? "?"}`, "no slug or name");
        continue;
      }
      const path = text(c.path) ? normalizePagePath(c.path) : null;
      if (path && pagePathProblems(path).length > 0) {
        skip(`product category ${path}`, pagePathProblems(path)[0].replace(/^"path" /, ""));
        continue;
      }
      categories.push({
        id: String(c.id ?? ""),
        slug: c.slug,
        name: c.name.trim(),
        path,
        parentSlug: c.parentSlug ?? null,
        description: text(c.description) ? rw.content(c.description) : null,
        image: text(c.image) ? rw.asset(c.image) : null,
        productCount: Number.isInteger(c.productCount) ? c.productCount : null,
        ...(Array.isArray(c.productIds) ? { productIds: c.productIds.map(String) } : {}),
      });
    }
    // The old shop list page: its H1, intro and SEO, so the shop list keeps them.
    let index;
    const shopCrawled = shopPath ? crawledByPath.get(shopPath) : undefined;
    const shopApi = shopPath ? apiPages.find((p) => text(p?.path) && normalizePagePath(p.path) === shopPath) : undefined;
    if (shopCrawled || shopApi) {
      const { seo: s, title } = pageSeo(shopCrawled, shopApi);
      const seo = templateSeo(s, rw, siteUrl);
      const description = text(shopApi?.excerpt) ? stripTags(shopApi.excerpt) : s.description;
      index = {
        ...(title ? { title } : {}),
        ...(description ? { description } : {}),
        ...(Object.keys(seo).length > 0 ? { seo } : {}),
      };
    }
    catalog = { importedFrom: origin, platform, indexPath: shopPath, ...(index ? { index } : {}), currency, categories, items };
    report.counts.products = items.length;
    report.counts.productCategories = categories.length;
    if (withoutBody > 0) report.notes.push(`${withoutBody} product(s) have no description HTML in the model; their shortDescription is all there is`);
    if (!currency && !items.some((i) => i.currency)) report.todo.push("products.json has no currency: ask the owner which currency the prices are in");
    report.todo.push(
      `products.json holds ${items.length} product(s) and ${categories.length} categor${categories.length === 1 ? "y" : "ies"}: the template renders the shop list at ${shopPath ?? "/shop/"}, each product and each category at its old path from it. Compare them with the old screenshots. Buy buttons open the product enquiry form; set a product's "buyUrl" only for a store that still takes orders. A real checkout needs the owner's go-ahead: then move the products into a database table with products.json as the seed`,
    );
  }

  // Navigation.
  const nav = {};
  const navIn = isObj(model?.navigation) ? model.navigation : {};
  const header = toLinks(navIn.header) ?? menuLinks(navIn.menus, /primary|header|main|top/i);
  const footer = toLinks(navIn.footer) ?? menuLinks(navIn.menus, /footer|bottom/i);
  if (header) nav.header = mapStrings(header, rw.content);
  if (footer) nav.footer = mapStrings(footer, rw.content);
  report.counts.headerLinks = header?.length ?? 0;
  report.counts.footerLinks = footer?.length ?? 0;

  // Old URLs with no page yet.
  const oldPaths = arr(opts.oldUrls?.paths).filter(text);
  if (oldPaths.length > 0) {
    const known = new Set([...pages.map((p) => p.path), ...posts.map((p) => p.path), ...(blog ? [blog.path] : []), ...productPaths, ...(shopPath ? [shopPath] : [])]);
    const redirected = new Set(
      [...arr(model?.redirects), ...arr(opts.redirects?.redirects)].map((r) => (text(r?.from) ? normalizePagePath(r.from) : null)).filter(Boolean),
    );
    for (const t of [...(blogTerms?.categories ?? []), ...(blogTerms?.tags ?? [])]) if (t.path) known.add(t.path);
    const bare = oldPaths.filter((p) => !known.has(normalizePagePath(p)) && !redirected.has(normalizePagePath(p)));
    if (bare.length > 0) {
      report.todo.push(`${bare.length} old URL(s) in old-urls.json have no page, post or product yet: build each or add a 301 to the closest page: ${sample(bare, 5)}`);
    }
  }

  if (rw.leftOnOldSite.size > 0) {
    report.notes.push(`${rw.leftOnOldSite.size} file URL(s) on the old site have no rehosted copy and still point there: ${sample([...rw.leftOnOldSite])}`);
  }

  return { pages, posts, blog, blogTerms, catalog, nav: header || footer ? nav : null, report };
}

function term(t) {
  return {
    slug: String(t?.slug ?? ""),
    name: text(t?.name) ?? String(t?.slug ?? ""),
    path: text(t?.path) ? normalizePagePath(t.path) : null,
    count: Number.isInteger(t?.count) ? t.count : null,
  };
}

// ── Writing ──

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

/**
 * Read chipp/site-migration/ under `repoRoot` and write the landing content
 * files. Returns the report.
 */
export function importSiteModel({ repoRoot, force = false }) {
  const modelFile = join(repoRoot, MODEL_PATH);
  if (!existsSync(modelFile)) throw new Error(`${modelFile} not found`);
  const model = readJson(modelFile);
  if (!isObj(model)) throw new Error(`${MODEL_PATH} is not a JSON object`);
  const contentDir = join(repoRoot, "landing", "src", "content");
  const siteFile = join(contentDir, "site.json");
  const site = readJson(siteFile);
  const root = resolve(repoRoot);
  const readContent = makeContentReader((repoPath) => {
    const file = resolve(root, repoPath);
    if (!file.startsWith(`${resolve(root, CONTENT_DIR)}${sep}`)) throw new Error("outside the content folder");
    return readJson(file);
  });
  const optional = (p) => (existsSync(join(repoRoot, p)) ? readJson(join(repoRoot, p)) : undefined);
  const plan = planImport(model, site, {
    readContent,
    oldUrls: optional(OLD_URLS_PATH),
    redirects: optional("chipp/redirects.json"),
  });
  const { report } = plan;

  const usedNames = new Map();
  const write = (rel, data) => {
    const file = join(contentDir, rel);
    if (existsSync(file) && !force) {
      report.kept.push(rel);
      return;
    }
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
    report.written.push(rel);
  };
  const fileFor = (dir, path) => {
    let name = fileNameForPath(path);
    const key = `${dir}/${name}`;
    const n = (usedNames.get(key) ?? 0) + 1;
    usedNames.set(key, n);
    if (n > 1) name = `${name}-${n}`;
    return `${dir}/${name}.json`;
  };
  for (const page of plan.pages) write(fileFor("pages", page.path), page);
  for (const post of plan.posts) write(fileFor("posts", post.path), post);
  if (plan.catalog) write("products.json", plan.catalog);
  if (plan.blogTerms) write("blog-terms.json", plan.blogTerms);

  let siteChanged = false;
  if (plan.blog && !site.blog) {
    site.blog = plan.blog;
    siteChanged = true;
  }
  if (plan.nav && !site.nav) {
    site.nav = plan.nav;
    siteChanged = true;
  }
  if (siteChanged) {
    writeFileSync(siteFile, JSON.stringify(site, null, 2) + "\n");
    report.written.push("site.json");
  }
  return report;
}

/** The report as terminal lines. */
export function formatReport(report) {
  const lines = [];
  const p = report.platform;
  if (p) {
    const name = PLATFORM_NAMES[p.platform] ?? p.platform;
    lines.push(
      `Platform: ${name}${p.confidence ? ` (${p.confidence} confidence)` : ""}${p.signals.length ? `: ${p.signals.slice(0, 3).join("; ")}` : ""}`,
    );
    if (p.sources.length) lines.push(`Read through: ${p.sources.join(", ")}`);
  }
  const c = report.counts;
  lines.push(
    `Imported: ${c.pages} page(s), ${c.posts} post(s), ${c.forms} form(s), ${c.headerLinks} header and ${c.footerLinks} footer link(s), ` +
      `${c.products} product(s), ${c.productCategories} product categor${c.productCategories === 1 ? "y" : "ies"}, ` +
      `${c.blogCategories} blog categor${c.blogCategories === 1 ? "y" : "ies"}, ${c.blogTags} blog tag(s)`,
  );
  const dirs = {};
  for (const f of report.written) dirs[f.split("/")[0]] = (dirs[f.split("/")[0]] ?? 0) + 1;
  lines.push(`Wrote ${report.written.length} file(s) in landing/src/content/${Object.keys(dirs).length ? ` (${Object.entries(dirs).map(([d, n]) => `${d}: ${n}`).join(", ")})` : ""}`);
  if (report.kept.length) lines.push(`Kept ${report.kept.length} existing file(s) (-- --force replaces them): ${sample(report.kept, 5)}`);
  const list = (title, items) => {
    if (items.length === 0) return;
    lines.push(`${title} (${items.length}):`);
    for (const i of items) lines.push(`  - ${i}`);
  };
  list("Skipped", report.skipped);
  list("Notes", report.notes);
  list("TODO", report.todo);
  return lines;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = join(here, "..", "..");
  try {
    const report = importSiteModel({ repoRoot, force: process.argv.includes("--force") });
    for (const line of formatReport(report)) console.log(`[import] ${line}`);
  } catch (err) {
    console.error(`[import] ${err.message}`);
    process.exit(1);
  }
}
