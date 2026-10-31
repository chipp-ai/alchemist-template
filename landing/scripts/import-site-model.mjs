#!/usr/bin/env node
// Import a migrated site's model into the landing content files.
//
// Chipp crawls the builder's old site and writes chipp/site-migration/
// site-model.json. This script copies the parts that must not be retyped by
// hand, exactly as the old site had them:
//
//   - one src/content/pages/<name>.json per page, at the same path, with the
//     title, description, canonical, Open Graph and JSON-LD; the sections
//     the crawler mapped to this template's section types; and a form
//     section for every form on the page
//   - one src/content/posts/<name>.json per blog post, at its old path
//   - site.json "blog" (the list page) and "nav" (the old header and
//     footer links), only when site.json does not have them yet
//
// Every old asset URL becomes its rehosted URL (assets[].newUrl), and links
// to the old origin become site paths. It never invents words: a page the
// crawler could not map gets no sections, and the build then fails until the
// page is rebuilt from its screenshot. Existing page and post files are kept
// unless --force is given. It never writes chipp/redirects.json.
//
// Usage (from landing/): npm run import:site-model [-- --force]

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { FORM_FIELD_TYPES, normalizePagePath, sectionProblems } from "../src/lib/composed.ts";

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

function slugify(text, fallback) {
  const s = String(text ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
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
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, mapStrings(v, fn)]));
  }
  return value;
}

/**
 * The string rewriter for one model: rehosted assets first (longest old URL
 * first, so a prefix never wins), then old-origin URLs to site paths.
 */
export function makeRewriter(model) {
  const assets = (model.assets ?? [])
    .filter((a) => typeof a?.oldUrl === "string" && typeof a?.newUrl === "string" && a.oldUrl)
    .sort((a, b) => b.oldUrl.length - a.oldUrl.length);
  const origin = typeof model.meta?.origin === "string" ? model.meta.origin.replace(/\/+$/, "") : "";
  // Old-origin URLs, http or https, with or without "www.".
  let originRe = null;
  if (origin) {
    const host = new URL(origin).host.replace(/^www\./, "");
    originRe = new RegExp(`https?://(?:www\\.)?${escapeRegExp(host)}(?=[/"'\\s<>?#]|$)(/[^"'\\s<>]*)?`, "g");
  }
  const assetsOnly = (s) => assets.reduce((acc, a) => acc.split(a.oldUrl).join(a.newUrl), s);
  return {
    /** Assets rehosted, old-origin links made site-relative. */
    content: (s) => {
      const out = assetsOnly(s);
      return originRe ? out.replace(originRe, (_m, path) => path || "/") : out;
    },
    /** Assets rehosted, old origin swapped for the new site URL when known (for JSON-LD). */
    structured: (s, siteUrl) => {
      const out = assetsOnly(s);
      return originRe && siteUrl ? out.replace(originRe, (_m, path) => `${siteUrl.replace(/\/+$/, "")}${path || "/"}`) : out;
    },
  };
}

function toImage(v) {
  if (typeof v === "string" && v) return { src: v, alt: "" };
  if (v && typeof v === "object" && typeof v.src === "string") return { src: v.src, alt: typeof v.alt === "string" ? v.alt : "" };
  return undefined;
}

function toLinks(list) {
  if (!Array.isArray(list)) return undefined;
  const out = list
    .map((l) => ({ label: l?.label ?? l?.text ?? l?.title, href: l?.href ?? l?.url }))
    .filter((l) => typeof l.label === "string" && l.label.trim() && typeof l.href === "string" && l.href.trim());
  return out.length > 0 ? out : undefined;
}

function stripTags(html) {
  return String(html ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

/** A SiteModel form as a template form, plus any notes about what changed. */
export function convertForm(form) {
  const notes = [];
  const name = slugify(form.name, "form");
  const used = new Set();
  const fields = [];
  for (const [i, f] of (form.fields ?? []).entries()) {
    let fieldName = String(f?.name ?? "").replace(/[^A-Za-z0-9_-]/g, "_").replace(/^[^A-Za-z]+/, "");
    if (!fieldName) fieldName = `field_${i + 1}`;
    while (used.has(fieldName)) fieldName = `${fieldName}_${i + 1}`;
    used.add(fieldName);
    const raw = String(f?.type ?? "text").toLowerCase();
    const options = Array.isArray(f?.options) ? f.options.map((o) => (typeof o === "string" ? o : o?.label ?? o?.value)).filter(Boolean) : undefined;
    let type = FORM_FIELD_TYPES.includes(raw) ? raw : FIELD_TYPE_ALIASES[raw];
    if (type === "checkbox" && options && options.length > 1) type = "checkboxes";
    if (!type) {
      notes.push(`form "${name}" field "${fieldName}": type "${raw}" is not supported; imported as a text field`);
      type = "text";
    }
    const field = { name: fieldName, label: String(f?.label ?? f?.name ?? fieldName), type };
    if (f?.required) field.required = true;
    if (options && ["select", "radio", "checkboxes"].includes(type)) field.options = options;
    if (type === "hidden") field.value = typeof f?.value === "string" ? f.value : "";
    if (typeof f?.placeholder === "string" && f.placeholder) field.placeholder = f.placeholder;
    fields.push(field);
  }
  return { form: { name, fields }, notes };
}

/**
 * Turn a SiteModel into landing content. Pure: returns the files to write
 * and a report; `importSiteModel` writes them.
 */
export function planImport(model, site = {}) {
  const rw = makeRewriter(model);
  const origin = String(model.meta?.origin ?? "").replace(/\/+$/, "");
  const report = { pages: [], posts: [], skippedSections: [], todo: [], notes: [...(model.warnings ?? []).map(String)] };
  const pages = [];
  const posts = [];

  const blogCollection = (model.collections ?? []).find((c) => c?.type === "blog" || c?.type === "posts") ??
    (model.collections ?? []).find((c) => Array.isArray(c?.items) && c.items.some((i) => typeof i?.html === "string"));
  const blogPath = blogCollection ? normalizePagePath(blogCollection.path ?? "/blog/") : null;

  for (const raw of model.pages ?? []) {
    if (typeof raw?.path !== "string") continue;
    const path = normalizePagePath(raw.path);
    if (path === blogPath) continue; // the blog list page, built from the posts
    const seoIn = raw.seo ?? {};
    const seo = {};
    const title = String(seoIn.title ?? raw.title ?? "").trim() || path;
    if (seoIn.title) seo.title = seoIn.title;
    if (seoIn.description) seo.description = seoIn.description;
    if (seoIn.canonical) seo.canonical = rw.content(seoIn.canonical);
    if (seoIn.og && typeof seoIn.og === "object") {
      seo.og = Object.fromEntries(
        Object.entries(seoIn.og).filter(([, v]) => typeof v === "string").map(([k, v]) => [k.replace(/^og:/, ""), rw.structured(v, site.url)]),
      );
    }
    if (Array.isArray(seoIn.jsonLd) && seoIn.jsonLd.length > 0) seo.jsonLd = mapStrings(seoIn.jsonLd, (s) => rw.structured(s, site.url));
    else if (seoIn.jsonLd && typeof seoIn.jsonLd === "object") seo.jsonLd = [mapStrings(seoIn.jsonLd, (s) => rw.structured(s, site.url))];
    if (seoIn.noindex === true) seo.noindex = true;

    const sections = [];
    for (const [i, s] of (raw.sections ?? []).entries()) {
      const mapped = mapStrings(s, rw.content);
      const problems = sectionProblems(mapped, `${path} sections[${i}]`);
      if (problems.length === 0) sections.push(mapped);
      else report.skippedSections.push(`${path} sections[${i}] (${s?.type ?? "no type"}): ${problems[0]}`);
    }
    const page = { path, title, seo, importedFrom: `${origin}${raw.path}`, sections };
    pages.push(page);
    if (sections.length === 0) {
      const shot = raw.screenshot?.desktop ?? raw.screenshot?.mobile;
      report.todo.push(`${path}: no sections were mapped; rebuild it from ${shot ?? "the old page"}`);
    }
  }

  for (const f of model.forms ?? []) {
    const { form, notes } = convertForm(f);
    report.notes.push(...notes);
    const target = pages.find((p) => p.path === normalizePagePath(String(f.pagePath ?? "/")));
    if (!target) {
      report.todo.push(`form "${form.name}" belongs to ${f.pagePath}, which is not a page; place it by hand`);
      continue;
    }
    target.sections.push({ type: "form", form });
  }

  let blog = null;
  if (blogCollection) {
    const listPage = (model.pages ?? []).find((p) => typeof p?.path === "string" && normalizePagePath(p.path) === blogPath);
    blog = {
      path: blogPath,
      title: String(blogCollection.title ?? listPage?.seo?.title ?? listPage?.title ?? "").trim(),
      description: String(blogCollection.description ?? listPage?.seo?.description ?? "").trim(),
    };
    if (!blog.title || !blog.description) {
      report.todo.push(`site.json blog: fill "title" and "description" from the old blog page ${blogPath}`);
    }
    for (const item of blogCollection.items ?? []) {
      const itemPath = item?.path ?? (item?.url ? new URL(item.url, origin || "https://x.invalid").pathname : null) ??
        `${blogPath}${slugify(item?.slug, "post")}/`;
      const post = {
        path: normalizePagePath(itemPath),
        title: String(item?.title ?? "").trim(),
        date: String(item?.date ?? "").slice(0, 10),
        html: rw.content(String(item?.html ?? "")),
        importedFrom: `${origin}${itemPath}`,
      };
      const description = item?.description ?? item?.excerpt;
      if (description) post.description = stripTags(description);
      if (item?.author) post.author = String(item.author);
      if (item?.updatedAt) post.updatedAt = String(item.updatedAt).slice(0, 10);
      const image = toImage(typeof item?.image === "string" ? rw.content(item.image) : item?.image && mapStrings(item.image, rw.content));
      if (image) post.image = image;
      if (item?.seo && typeof item.seo === "object") post.seo = mapStrings(item.seo, rw.content);
      posts.push(post);
    }
  }

  const nav = {};
  const header = toLinks(model.navigation?.header);
  const footer = toLinks(model.navigation?.footer);
  if (header) nav.header = mapStrings(header, rw.content);
  if (footer) nav.footer = mapStrings(footer, rw.content);

  return { pages, posts, blog, nav: header || footer ? nav : null, report };
}

/**
 * Read chipp/site-migration/site-model.json under `repoRoot` and write the
 * landing content files. Returns the report.
 */
export function importSiteModel({ repoRoot, force = false }) {
  const modelFile = join(repoRoot, "chipp", "site-migration", "site-model.json");
  if (!existsSync(modelFile)) throw new Error(`${modelFile} not found`);
  const model = JSON.parse(readFileSync(modelFile, "utf8"));
  const contentDir = join(repoRoot, "landing", "src", "content");
  const siteFile = join(contentDir, "site.json");
  const site = JSON.parse(readFileSync(siteFile, "utf8"));
  const plan = planImport(model, site);
  const write = (dir, name, data, list) => {
    const file = join(contentDir, dir, `${name}.json`);
    if (existsSync(file) && !force) {
      list.push(`kept ${dir}/${name}.json (exists; --force replaces it)`);
      return;
    }
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
    list.push(`wrote ${dir}/${name}.json (${data.path})`);
  };
  for (const page of plan.pages) write("pages", fileNameForPath(page.path), page, plan.report.pages);
  for (const post of plan.posts) write("posts", fileNameForPath(post.path), post, plan.report.posts);

  let siteChanged = false;
  if (plan.blog && !site.blog) {
    site.blog = plan.blog;
    siteChanged = true;
  }
  if (plan.nav && !site.nav) {
    site.nav = plan.nav;
    siteChanged = true;
  }
  if (siteChanged) writeFileSync(siteFile, JSON.stringify(site, null, 2) + "\n");
  return plan.report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = join(here, "..", "..");
  try {
    const report = importSiteModel({ repoRoot, force: process.argv.includes("--force") });
    for (const line of [...report.pages, ...report.posts]) console.log(`[import] ${line}`);
    for (const line of report.skippedSections) console.log(`[import] skipped section ${line}`);
    for (const line of report.notes) console.log(`[import] note: ${line}`);
    for (const line of report.todo) console.log(`[import] TODO ${line}`);
  } catch (err) {
    console.error(`[import] ${err.message}`);
    process.exit(1);
  }
}
