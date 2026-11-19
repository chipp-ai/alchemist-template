/**
 * Campaign variants of a landing page (dynamic targeting).
 *
 * A campaign is one file, `src/content/campaigns/<id>.json`. It names the
 * page it changes, the URL values that select it (UTM values from an ad,
 * an email or a QR code), and the words that change: the hero and its main
 * call to action, plus the <title> and meta description.
 *
 *   {
 *     "name": "Dentists, Google Search",
 *     "page": "/",
 *     "match": { "utm_campaign": ["dentists-*"], "utm_term": ["*dentist*"] },
 *     "hero": {
 *       "headline": "The AI receptionist for dental offices",
 *       "subhead": "Acme answers patient calls, books cleanings and fills cancellations.",
 *       "cta": { "label": "Start a free trial", "href": "/app/#/signup" }
 *     }
 *   }
 *
 * How it works:
 *   - The build makes one static page per campaign at `/_campaign/<id>/`
 *     (noindex, canonical to the base page), so a variant is plain HTML
 *     like every other page and passes the same AEO check.
 *   - The app server (src/lib/landing-site.ts) answers a request for the
 *     base page with the variant when the URL selects one, before any HTML
 *     is sent. There is no flicker, and the visitor's address bar keeps
 *     the ad's URL.
 *   - `?campaign=<id>` always selects that campaign (a QR code, a test link).
 *     Otherwise the first campaign, by `order` then id, whose `match` fits.
 *   - The variant only ever shows words from this file. Nothing from the
 *     URL is printed on the page.
 *
 * Pure: no Astro, no Node or Deno APIs. The landing build and the Deno
 * server both import it, so they always agree on what a campaign is.
 */

/** The URL value that selects a campaign by id. */
export const CAMPAIGN_PARAM = "campaign";

/** Where the build writes a campaign's page: `/_campaign/<id>/`. */
export const CAMPAIGN_PATH_PREFIX = "/_campaign/";

/** The URL values a lead keeps as attribution (src/api/routes/site-forms). */
export const ATTRIBUTION_PARAMS = [
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "gclid",
  "gbraid",
  "wbraid",
  "fbclid",
  "msclkid",
  "li_fat_id",
  "ttclid",
  CAMPAIGN_PARAM,
] as const;

const ID_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;
const PARAM_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const MAX_PATTERNS = 50;
const MAX_PATTERN_LENGTH = 200;

export interface CampaignLink {
  label: string;
  href: string;
}

export interface CampaignHero {
  eyebrow?: string;
  /** The H1. */
  headline?: string;
  /** The plain sentence under the H1. 60 words or less (AEO rule 3). */
  subhead?: string;
  /** The main call to action. */
  cta?: CampaignLink;
}

export interface Campaign {
  /** The file name without `.json`: lowercase letters, digits and dashes. */
  id: string;
  /** What a person calls it: "Dentists, Google Search". */
  name: string;
  /** The page it changes. Default "/". */
  page: string;
  /**
   * URL value name -> patterns. A campaign matches when any value matches
   * any of its patterns. Case-insensitive; `*` matches any run of
   * characters. Empty or absent: only `?campaign=<id>` selects it.
   */
  match: Record<string, string[]>;
  /** Lower first. Default 100. Ties go by id. */
  order: number;
  hero: CampaignHero;
  /** The <title>. Default: the base page's. */
  title?: string;
  /** The meta description. Default: the base page's. */
  description?: string;
}

/** "/pricing" -> "/pricing/". Same rule as normalizePagePath in composed.ts. */
export function campaignPagePath(path: string): string {
  let p = path.trim().split(/[?#]/, 1)[0];
  if (!p.startsWith("/")) p = `/${p}`;
  p = p.replace(/\/{2,}/g, "/");
  if (!p.endsWith("/")) p = `${p}/`;
  return p;
}

/** The built page of a campaign: "/_campaign/<id>/". */
export function campaignPath(id: string): string {
  return `${CAMPAIGN_PATH_PREFIX}${id}/`;
}

/** The id of a campaign file: "src/content/campaigns/dentists.json" -> "dentists". */
export function campaignIdOf(file: string): string {
  return (file.split("/").pop() ?? "").replace(/\.json$/i, "");
}

function text(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function wordCount(s: string): number {
  return s.split(/\s+/).filter(Boolean).length;
}

function safeHref(href: string): boolean {
  if (/^\s*(javascript|data|vbscript):/i.test(href)) return false;
  return href.startsWith("/") || href.startsWith("#") || /^(https?:|mailto:|tel:)/i.test(href);
}

/**
 * Check one campaign file. Returns the campaign, or the problems that make
 * it unusable (every one, so a person fixes them in one pass).
 */
export function parseCampaign(file: string, data: unknown): { campaign: Campaign | null; problems: string[] } {
  const where = file;
  const problems: string[] = [];
  const id = campaignIdOf(file);
  if (!ID_RE.test(id)) {
    problems.push(`${where}: the file name must be lowercase letters, digits and dashes, 1 to 48 characters (it is the campaign id)`);
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { campaign: null, problems: [...problems, `${where}: must be a JSON object`] };
  }
  const d = data as Record<string, unknown>;

  const name = text(d.name);
  if (!name) problems.push(`${where}.name: required (what a person calls this campaign)`);

  let page = "/";
  if (d.page !== undefined) {
    if (typeof d.page !== "string" || !d.page.startsWith("/") || /[?#\s\\]/.test(d.page)) {
      problems.push(`${where}.page: a clean page path such as "/" or "/pricing/"`);
    } else {
      page = campaignPagePath(d.page);
    }
  }

  const match: Record<string, string[]> = {};
  if (d.match !== undefined) {
    if (!d.match || typeof d.match !== "object" || Array.isArray(d.match)) {
      problems.push(`${where}.match: an object of URL value name -> list of patterns, e.g. { "utm_campaign": ["dentists-*"] }`);
    } else {
      let count = 0;
      for (const [param, raw] of Object.entries(d.match as Record<string, unknown>)) {
        if (!PARAM_RE.test(param)) {
          problems.push(`${where}.match: "${param}" is not a URL value name`);
          continue;
        }
        if (param === CAMPAIGN_PARAM) {
          problems.push(`${where}.match.${param}: "?${CAMPAIGN_PARAM}=${id || "<id>"}" always selects this campaign; leave it out of match`);
          continue;
        }
        const list = typeof raw === "string" ? [raw] : raw;
        if (!Array.isArray(list) || list.some((p) => typeof p !== "string" || !p.trim() || p.length > MAX_PATTERN_LENGTH)) {
          problems.push(`${where}.match.${param}: a list of non-empty patterns, ${MAX_PATTERN_LENGTH} characters or less each`);
          continue;
        }
        if (list.some((p) => (p as string).replace(/\*/g, "").trim() === "")) {
          problems.push(`${where}.match.${param}: a pattern of only "*" matches every visitor; give real text`);
          continue;
        }
        count += list.length;
        match[param] = (list as string[]).map((p) => p.trim());
      }
      if (count > MAX_PATTERNS) problems.push(`${where}.match: ${MAX_PATTERNS} patterns or less in all`);
    }
  }

  let order = 100;
  if (d.order !== undefined) {
    if (typeof d.order !== "number" || !Number.isFinite(d.order)) problems.push(`${where}.order: a number (lower first)`);
    else order = d.order;
  }

  const hero: CampaignHero = {};
  if (!d.hero || typeof d.hero !== "object" || Array.isArray(d.hero)) {
    problems.push(`${where}.hero: required, with at least a headline, subhead or cta`);
  } else {
    const h = d.hero as Record<string, unknown>;
    for (const k of ["eyebrow", "headline", "subhead"] as const) {
      if (h[k] === undefined) continue;
      const v = text(h[k]);
      if (!v) problems.push(`${where}.hero.${k}: non-empty text`);
      else hero[k] = v;
    }
    if (hero.subhead && wordCount(hero.subhead) > 60) {
      problems.push(`${where}.hero.subhead: 60 words or less (the plain definition under the H1)`);
    }
    if (hero.headline && hero.headline.length > 160) problems.push(`${where}.hero.headline: 160 characters or less`);
    if (h.cta !== undefined) {
      const c = (h.cta && typeof h.cta === "object" ? h.cta : {}) as Record<string, unknown>;
      const label = text(c.label);
      const href = text(c.href);
      if (!label || !href) problems.push(`${where}.hero.cta: { "label": ..., "href": ... }`);
      else if (!safeHref(href)) problems.push(`${where}.hero.cta.href: a path ("/app/#/signup"), a #anchor, or an http(s), mailto: or tel: link`);
      else hero.cta = { label, href };
    }
    if (!hero.eyebrow && !hero.headline && !hero.subhead && !hero.cta) {
      problems.push(`${where}.hero: change at least one of headline, subhead, eyebrow or cta`);
    }
  }

  const title = d.title === undefined ? undefined : text(d.title);
  if (d.title !== undefined && !title) problems.push(`${where}.title: non-empty text`);
  const description = d.description === undefined ? undefined : text(d.description);
  if (d.description !== undefined && !description) problems.push(`${where}.description: non-empty text`);

  if (problems.length > 0 || !name) return { campaign: null, problems };
  return { campaign: { id, name, page, match, order, hero, title, description }, problems: [] };
}

/**
 * Check every campaign file together. Ids are unique by construction (one
 * file each). Sorted the way the server tries them.
 */
export function parseCampaigns(files: { file: string; data: unknown }[]): { campaigns: Campaign[]; problems: string[] } {
  const campaigns: Campaign[] = [];
  const problems: string[] = [];
  for (const { file, data } of files) {
    const r = parseCampaign(file, data);
    problems.push(...r.problems);
    if (r.campaign) campaigns.push(r.campaign);
  }
  return { campaigns: sortCampaigns(campaigns), problems };
}

export function sortCampaigns(list: Campaign[]): Campaign[] {
  return [...list].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}

function patternRe(pattern: string): RegExp {
  const body = pattern.split("*").map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*");
  return new RegExp(`^${body}$`, "i");
}

/** True when one URL value fits one pattern. Case-insensitive; `*` is a wildcard. */
export function patternMatches(pattern: string, value: string): boolean {
  return patternRe(pattern.trim()).test(value.trim());
}

/** True when the campaign's `match` fits the URL values. */
export function campaignMatches(campaign: Campaign, params: URLSearchParams): boolean {
  for (const [param, patterns] of Object.entries(campaign.match)) {
    const values = params.getAll(param);
    if (values.some((v) => v.trim() && patterns.some((p) => patternMatches(p, v)))) return true;
  }
  return false;
}

/**
 * The campaign a visitor to `pagePath` with these URL values gets, or null
 * for the base page. `?campaign=<id>` wins when that id is a campaign for
 * this page; otherwise the first campaign (in list order) that matches.
 */
export function selectCampaign(campaigns: Campaign[], pagePath: string, params: URLSearchParams): Campaign | null {
  const page = campaignPagePath(pagePath);
  const forPage = campaigns.filter((c) => c.page === page);
  if (forPage.length === 0) return null;
  const named = params.get(CAMPAIGN_PARAM)?.trim().toLowerCase();
  if (named) {
    const hit = forPage.find((c) => c.id === named);
    if (hit) return hit;
  }
  return forPage.find((c) => campaignMatches(c, params)) ?? null;
}

/**
 * The attribution values in a URL: the UTM values, the ad click ids and
 * `campaign`, each cut to 200 characters. Empty when there are none.
 */
export function attributionOf(params: URLSearchParams): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of ATTRIBUTION_PARAMS) {
    const v = params.get(k)?.trim();
    if (v) out[k] = v.slice(0, 200);
  }
  return out;
}
