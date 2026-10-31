/**
 * Composed pages: any number of landing pages at any path, each built from
 * reusable sections. One JSON file per page in `src/content/pages/`, one per
 * blog post in `src/content/posts/`. A rebuilt (migrated) site uses these;
 * the classic three pages (home, about, pricing from site.json) keep working
 * next to them.
 *
 * The rules:
 *   - A composed page for "/" makes the whole site composed: every page
 *     comes from src/content/pages/, and the classic about and pricing
 *     pages are not built.
 *   - Without one, the classic pages build exactly as before, and composed
 *     pages can add more paths next to them (e.g. "/services/roofing/").
 *
 * No imports: the Deno server reads the form sections from the same files
 * (src/services/site-forms.service.ts), and the Deno tests load this file
 * directly.
 */

// ── Shared shapes ──

export interface SiteLinkRef {
  label: string;
  href: string;
}

export interface SiteImage {
  /** A rehosted asset URL (assets[].newUrl) or a path in landing/public. */
  src: string;
  /** Describe the picture. "" only for decoration. */
  alt: string;
  width?: number;
  height?: number;
  caption?: string;
}

// ── Sections ──

export interface HeroSection {
  type: "hero";
  eyebrow?: string;
  heading: string;
  /** The plain sentence right under the heading. */
  subhead?: string;
  image?: SiteImage;
  actions?: SiteLinkRef[];
}

export interface FeaturesSection {
  type: "features";
  heading?: string;
  intro?: string;
  items: { title: string; body: string; image?: SiteImage }[];
}

export interface GallerySection {
  type: "gallery";
  heading?: string;
  intro?: string;
  images: SiteImage[];
}

export interface TestimonialsSection {
  type: "testimonials";
  heading?: string;
  items: { quote: string; name: string; role?: string }[];
}

export interface PricingSection {
  type: "pricing";
  heading?: string;
  intro?: string;
  plans: {
    name: string;
    price: string;
    period?: string;
    description?: string;
    features?: string[];
    cta?: SiteLinkRef;
  }[];
}

export interface FaqSection {
  type: "faq";
  heading?: string;
  /** Plain text answers. The FAQPage JSON-LD repeats them word for word. */
  items: { question: string; answer: string }[];
}

export interface CtaSection {
  type: "cta";
  heading: string;
  body?: string;
  action: SiteLinkRef;
}

export interface RichTextSection {
  type: "richText";
  heading?: string;
  /** HTML. Sanitized at build time: no scripts, styles, forms or iframes from unknown hosts. */
  html: string;
}

export const FORM_FIELD_TYPES = [
  "text",
  "email",
  "tel",
  "url",
  "number",
  "date",
  "textarea",
  "select",
  "radio",
  "checkbox",
  "checkboxes",
  "hidden",
] as const;

export type FormFieldType = typeof FORM_FIELD_TYPES[number];

export interface FormField {
  /** The submitted key. Letters, digits, "_" and "-"; never starts with "_". */
  name: string;
  label: string;
  type: FormFieldType;
  required?: boolean;
  /** For select, radio and checkboxes. */
  options?: string[];
  placeholder?: string;
  /** Overrides the autocomplete the field type picks. */
  autocomplete?: string;
  /** For hidden fields only. */
  value?: string;
}

export interface SiteForm {
  /** Unique across the site. Submissions are stored and emailed under this name. */
  name: string;
  fields: FormField[];
  submitLabel?: string;
  successMessage?: string;
}

export interface FormSection {
  type: "form";
  heading?: string;
  intro?: string;
  form: SiteForm;
}

export interface TeamSection {
  type: "team";
  heading?: string;
  intro?: string;
  members: { name: string; role?: string; bio?: string; image?: SiteImage }[];
}

export interface LogosSection {
  type: "logos";
  heading?: string;
  logos: (SiteImage & { href?: string })[];
}

export interface HtmlSection {
  type: "html";
  /**
   * The fallback for a block no other section fits. Sanitized at build time
   * like richText. Prefer a real section whenever one fits.
   */
  html: string;
}

export type Section =
  | HeroSection
  | FeaturesSection
  | GallerySection
  | TestimonialsSection
  | PricingSection
  | FaqSection
  | CtaSection
  | RichTextSection
  | FormSection
  | TeamSection
  | LogosSection
  | HtmlSection;

export type SectionType = Section["type"];

export const SECTION_TYPES: SectionType[] = [
  "hero",
  "features",
  "gallery",
  "testimonials",
  "pricing",
  "faq",
  "cta",
  "richText",
  "form",
  "team",
  "logos",
  "html",
];

// ── Pages and posts ──

export interface PageSeo {
  /** The <title>. Defaults to the page title. */
  title?: string;
  /** The meta description. */
  description?: string;
  /** A path ("/about/") or an absolute URL. Defaults to this page's own URL. */
  canonical?: string;
  /** Open Graph values: { "title": ..., "image": ..., "type": ... }. */
  og?: Record<string, string>;
  /** Extra JSON-LD objects from the old site (Organization, LocalBusiness, ...). */
  jsonLd?: unknown[];
  /** Keep this page out of search engines and the sitemap. */
  noindex?: boolean;
}

export interface ComposedPage {
  /** The site path, e.g. "/", "/about/", "/services/roofing/". */
  path: string;
  title: string;
  seo?: PageSeo;
  /** The link text when this page shows in the generated nav. Omit to keep it out. */
  navLabel?: string;
  /** Order in the generated nav, lowest first. */
  navOrder?: number;
  /**
   * The old URL this page was rebuilt from. Set by the importer. Its words
   * came from that site, so the AEO check reports the content-shape rules
   * (question heading, definition under the H1) as warnings, not errors.
   */
  importedFrom?: string;
  /** ISO dates. Default: site.json publishedAt and updatedAt. */
  publishedAt?: string;
  updatedAt?: string;
  sections: Section[];
}

export interface BlogPost {
  /** The post's own path, the same as on the old site: "/blog/my-post/". */
  path: string;
  title: string;
  /** ISO date the post was published. */
  date: string;
  updatedAt?: string;
  author?: string;
  /** A plain one or two sentence summary, for the list and the meta description. */
  description?: string;
  image?: SiteImage;
  /** The post body. Sanitized at build time. */
  html: string;
  seo?: PageSeo;
  importedFrom?: string;
}

export interface BlogSettings {
  /** The list page path, e.g. "/blog/" or "/news/". */
  path: string;
  title: string;
  /** One plain sentence under the list's H1. */
  description: string;
  navLabel?: string;
}

// ── Paths ──

/**
 * The canonical form of a page path: a leading "/", a trailing "/", no
 * query, no fragment, no doubled slashes. "/About-Us" -> "/About-Us/".
 */
export function normalizePagePath(path: string): string {
  let p = path.trim().split(/[?#]/, 1)[0];
  if (!p.startsWith("/")) p = `/${p}`;
  p = p.replace(/\/{2,}/g, "/");
  if (!p.endsWith("/")) p = `${p}/`;
  return p;
}

/** The Astro rest param for a page path: "/" -> undefined, "/a/b/" -> "a/b". */
export function pathParam(path: string): string | undefined {
  const p = normalizePagePath(path).replace(/^\/|\/$/g, "");
  return p === "" ? undefined : p;
}

/** Last path segment of a page path that looks like a file: "/a/b.html". */
function hasFileExtension(path: string): boolean {
  const last = path.replace(/\/$/, "").split("/").pop() ?? "";
  return /\.[a-z0-9]{1,5}$/i.test(last);
}

/** Paths the server owns. A landing page there would never be served. */
const RESERVED_PREFIXES = ["/api/", "/app/", "/_astro/", "/.well-known/"];
const RESERVED_EXACT = new Set(["/health/", "/robots.txt/", "/sitemap.xml/", "/index.html/"]);

/** Problems with a page path, or [] when it is a clean site path. */
export function pagePathProblems(path: unknown): string[] {
  if (typeof path !== "string" || !path.startsWith("/")) return ['"path" must start with "/"'];
  if (/[?#\s\\]/.test(path)) return ['"path" must be a clean path: no query, fragment, spaces or backslashes'];
  if (path.split("/").some((s) => s === "." || s === "..")) return ['"path" must not have "." or ".." segments'];
  if (hasFileExtension(path)) {
    return [`"path" ${path} looks like a file; use a clean path and add a redirect from the old URL`];
  }
  const p = normalizePagePath(path);
  if (RESERVED_PREFIXES.some((r) => p.startsWith(r)) || RESERVED_EXACT.has(p)) {
    return [`"path" ${path} is served by the app, not the landing site`];
  }
  return [];
}

// ── Validation ──

const FIELD_NAME_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const FORM_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}/;

function isObj(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === "object" && !Array.isArray(v);
}

function str(v: unknown): v is string {
  return typeof v === "string" && v.trim() !== "";
}

function optStr(v: unknown): boolean {
  return v === undefined || typeof v === "string";
}

function imageProblems(v: unknown, where: string): string[] {
  if (!isObj(v)) return [`${where}: must be an image object { src, alt }`];
  const out: string[] = [];
  if (!str(v.src)) out.push(`${where}.src: required`);
  if (typeof v.alt !== "string") out.push(`${where}.alt: required (use "" only for decoration)`);
  return out;
}

function linkProblems(v: unknown, where: string): string[] {
  if (!isObj(v) || !str(v.label) || !str(v.href)) return [`${where}: must be { label, href }`];
  return [];
}

function listProblems(
  v: unknown,
  where: string,
  each: (item: Record<string, unknown>, at: string) => string[],
  { min = 1 } = {},
): string[] {
  if (!Array.isArray(v)) return [`${where}: must be a list`];
  if (v.length < min) return [`${where}: needs at least ${min} item(s)`];
  return v.flatMap((item, i) => isObj(item) ? each(item, `${where}[${i}]`) : [`${where}[${i}]: must be an object`]);
}

function need(item: Record<string, unknown>, at: string, ...keys: string[]): string[] {
  return keys.filter((k) => !str(item[k])).map((k) => `${at}.${k}: required`);
}

/** Problems with one form definition, or []. */
export function formProblems(form: unknown, where = "form"): string[] {
  if (!isObj(form)) return [`${where}: must be an object`];
  const out: string[] = [];
  if (typeof form.name !== "string" || !FORM_NAME_RE.test(form.name)) {
    out.push(`${where}.name: lowercase letters, digits and "-" (got ${JSON.stringify(form.name)})`);
  }
  if (!optStr(form.submitLabel)) out.push(`${where}.submitLabel: must be text`);
  if (!optStr(form.successMessage)) out.push(`${where}.successMessage: must be text`);
  const names = new Set<string>();
  out.push(...listProblems(form.fields, `${where}.fields`, (f, at) => {
    const p: string[] = [];
    if (typeof f.name !== "string" || !FIELD_NAME_RE.test(f.name)) {
      p.push(`${at}.name: a letter, then letters, digits, "_" or "-" (got ${JSON.stringify(f.name)})`);
    } else if (names.has(f.name)) {
      p.push(`${at}.name: "${f.name}" is used twice`);
    } else {
      names.add(f.name);
    }
    if (!(FORM_FIELD_TYPES as readonly string[]).includes(f.type as string)) {
      p.push(`${at}.type: one of ${FORM_FIELD_TYPES.join(", ")} (got ${JSON.stringify(f.type)})`);
    }
    if (f.type !== "hidden" && !str(f.label)) p.push(`${at}.label: required`);
    if (["select", "radio", "checkboxes"].includes(f.type as string)) {
      if (!Array.isArray(f.options) || f.options.length === 0 || !f.options.every(str)) {
        p.push(`${at}.options: a ${f.type} field needs a list of options`);
      }
    }
    if (f.required !== undefined && typeof f.required !== "boolean") p.push(`${at}.required: true or false`);
    return p;
  }));
  return out;
}

/** Problems with one section, or []. */
export function sectionProblems(s: unknown, where = "section"): string[] {
  if (!isObj(s)) return [`${where}: must be an object`];
  const at = `${where}(${String(s.type)})`;
  switch (s.type) {
    case "hero":
      return [
        ...need(s, at, "heading"),
        ...(s.image === undefined ? [] : imageProblems(s.image, `${at}.image`)),
        ...(s.actions === undefined ? [] : listProblems(s.actions, `${at}.actions`, (a, w) => linkProblems(a, w), { min: 0 })),
      ];
    case "features":
      return listProblems(s.items, `${at}.items`, (i, w) => [
        ...need(i, w, "title", "body"),
        ...(i.image === undefined ? [] : imageProblems(i.image, `${w}.image`)),
      ]);
    case "gallery":
      return Array.isArray(s.images) && s.images.length > 0
        ? s.images.flatMap((img, i) => imageProblems(img, `${at}.images[${i}]`))
        : [`${at}.images: needs at least 1 image`];
    case "testimonials":
      return listProblems(s.items, `${at}.items`, (i, w) => need(i, w, "quote", "name"));
    case "pricing":
      return listProblems(s.plans, `${at}.plans`, (p, w) => [
        ...need(p, w, "name", "price"),
        ...(p.features === undefined || (Array.isArray(p.features) && p.features.every(str))
          ? []
          : [`${w}.features: a list of text`]),
        ...(p.cta === undefined ? [] : linkProblems(p.cta, `${w}.cta`)),
      ]);
    case "faq":
      return listProblems(s.items, `${at}.items`, (i, w) => need(i, w, "question", "answer"));
    case "cta":
      return [...need(s, at, "heading"), ...linkProblems(s.action, `${at}.action`)];
    case "richText":
    case "html":
      return need(s, at, "html");
    case "form":
      return formProblems(s.form, `${at}.form`);
    case "team":
      return listProblems(s.members, `${at}.members`, (m, w) => [
        ...need(m, w, "name"),
        ...(m.image === undefined ? [] : imageProblems(m.image, `${w}.image`)),
      ]);
    case "logos":
      return Array.isArray(s.logos) && s.logos.length > 0
        ? s.logos.flatMap((img, i) => imageProblems(img, `${at}.logos[${i}]`))
        : [`${at}.logos: needs at least 1 logo`];
    default:
      return [`${where}: unknown section type ${JSON.stringify(s.type)}; use one of ${SECTION_TYPES.join(", ")}`];
  }
}

function seoProblems(seo: unknown, where: string): string[] {
  if (seo === undefined) return [];
  if (!isObj(seo)) return [`${where}: must be an object`];
  const out: string[] = [];
  for (const k of ["title", "description", "canonical"]) {
    if (!optStr(seo[k])) out.push(`${where}.${k}: must be text`);
  }
  if (seo.og !== undefined && (!isObj(seo.og) || !Object.values(seo.og).every((v) => typeof v === "string"))) {
    out.push(`${where}.og: an object of text values`);
  }
  if (seo.jsonLd !== undefined && !(Array.isArray(seo.jsonLd) && seo.jsonLd.every(isObj))) {
    out.push(`${where}.jsonLd: a list of JSON-LD objects`);
  }
  if (seo.noindex !== undefined && typeof seo.noindex !== "boolean") out.push(`${where}.noindex: true or false`);
  return out;
}

function dateProblems(item: Record<string, unknown>, where: string, keys: string[]): string[] {
  return keys
    .filter((k) => item[k] !== undefined && !(typeof item[k] === "string" && ISO_DATE_RE.test(item[k] as string)))
    .map((k) => `${where}.${k}: an ISO date (YYYY-MM-DD)`);
}

/** Problems with one composed page, or []. */
export function pageProblems(page: unknown, where = "page"): string[] {
  if (!isObj(page)) return [`${where}: must be an object`];
  const out = [
    ...pagePathProblems(page.path).map((p) => `${where}: ${p}`),
    ...need(page, where, "title"),
    ...seoProblems(page.seo, `${where}.seo`),
    ...dateProblems(page, where, ["publishedAt", "updatedAt"]),
  ];
  if (!Array.isArray(page.sections)) out.push(`${where}.sections: must be a list`);
  else page.sections.forEach((s, i) => out.push(...sectionProblems(s, `${where}.sections[${i}]`)));
  return out;
}

/** Problems with one blog post, or []. */
export function postProblems(post: unknown, where = "post"): string[] {
  if (!isObj(post)) return [`${where}: must be an object`];
  return [
    ...pagePathProblems(post.path).map((p) => `${where}: ${p}`),
    ...need(post, where, "title", "html"),
    ...(typeof post.date === "string" && ISO_DATE_RE.test(post.date) ? [] : [`${where}.date: an ISO date (YYYY-MM-DD)`]),
    ...dateProblems(post, where, ["updatedAt"]),
    ...(post.image === undefined ? [] : imageProblems(post.image, `${where}.image`)),
    ...seoProblems(post.seo, `${where}.seo`),
  ];
}

/** Problems with blog settings, or []. */
export function blogSettingsProblems(blog: unknown, where = "site.json blog"): string[] {
  if (blog === undefined) return [];
  if (!isObj(blog)) return [`${where}: must be an object`];
  return [...pagePathProblems(blog.path).map((p) => `${where}: ${p}`), ...need(blog, where, "title", "description")];
}

/** Every form section on a set of pages. */
export function formsOf(pages: ComposedPage[]): { form: SiteForm; pagePath: string }[] {
  return pages.flatMap((p) =>
    p.sections.filter((s): s is FormSection => s.type === "form").map((s) => ({ form: s.form, pagePath: p.path }))
  );
}

/**
 * Check a whole set of pages, posts and blog settings together: each one
 * alone, then no two pages at one path and no two forms with one name.
 * Returns problems; empty means the site builds.
 */
export function siteContentProblems(
  pages: { file: string; data: unknown }[],
  posts: { file: string; data: unknown }[],
  blog: unknown,
  reservedPaths: string[] = [],
): string[] {
  const out: string[] = [];
  for (const p of pages) out.push(...pageProblems(p.data, p.file));
  for (const p of posts) out.push(...postProblems(p.data, p.file));
  out.push(...blogSettingsProblems(blog));
  if (out.length > 0) return out;

  const owner = new Map<string, string>();
  const claim = (path: string, who: string) => {
    const key = normalizePagePath(path);
    const prior = owner.get(key);
    if (prior) out.push(`${who}: path ${key} is already used by ${prior}`);
    else owner.set(key, who);
  };
  for (const r of reservedPaths) owner.set(normalizePagePath(r), "a built-in page");
  for (const p of pages) claim((p.data as ComposedPage).path, p.file);
  if (blog) claim((blog as BlogSettings).path, "the blog list");
  for (const p of posts) claim((p.data as BlogPost).path, p.file);

  const formOwner = new Map<string, string>();
  for (const { form, pagePath } of formsOf(pages.map((p) => p.data as ComposedPage))) {
    const prior = formOwner.get(form.name);
    if (prior) out.push(`form "${form.name}" is defined on ${prior} and ${pagePath}; form names must be unique`);
    else formOwner.set(form.name, pagePath);
  }
  return out;
}
