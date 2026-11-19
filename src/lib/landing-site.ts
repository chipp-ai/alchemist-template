/**
 * The landing site: the static Astro build in `landing/dist`, served at "/"
 * (2026-10-19). The signed-in SPA lives at `APP_BASE_PATH` (src/config/site.ts).
 *
 * Why a separate site: answer engines and crawlers read raw static HTML. The
 * SPA renders nothing until its JS runs, so product facts that live only in
 * the SPA are invisible to them. landing/ follows the AEO rules in
 * landing/README.md and its build fails on a broken rule (scripts/aeo-check.mjs).
 *
 * The middleware serves a file only when it exists in `landing/dist`. Every
 * other request falls through to the SPA exactly as before, so a checkout that
 * has not built landing/ (local dev, an older image) behaves like it did before
 * the landing site existed.
 *
 * App-first mode (2026-10-22): a product whose app IS the homepage sets
 * `"homepage": "app"` in `landing/src/content/site.json`. Then "/" serves
 * the SPA shell (hash routes work: "/#/settings") and "/app/..." keeps
 * working for old links. Without the field, or with any other value, the
 * landing site owns "/" as before. The file ships in the image (the runtime
 * stage copies the repo), so the server reads it at boot.
 *
 * App-first mode still serves landing/dist's machine-readable and static
 * files (2026-10-23): llms.txt, llms-full.txt, robots.txt, sitemap.xml, the
 * favicon, /_astro/* and any other non-HTML file in the build. The
 * Builder's SEO settings write llms.txt to landing/public, so it lives
 * there in both modes. The marketing pages (/about, /pricing, any HTML page
 * in the build) are not served: they answer a 302 redirect to "/", so an
 * old link lands on the app instead of a stale page. 302, not 301, because
 * the mode is one line in site.json and a browser caches a 301 forever. The
 * sitemap lists only "/" in this mode (landing/src/lib/pages.ts).
 *
 * Signed-in visitors skip the landing page (2026-11-12). In landing mode a
 * GET or HEAD of "/" from someone with a valid session answers a 302 to the
 * app home (`appPath("/#/")`), so a member who opens the bare domain, or
 * follows a link to it, lands in the app. The landing page shows only to
 * signed-out visitors and crawlers. A platform verification session is not
 * redirected: the verifier checks the landing page as a visitor sees it.
 * Only "/" redirects; the other marketing pages stay readable signed in.
 * The check reads the session cookie and touches the database only when a
 * session_id cookie this app signed is present.
 *
 * Campaign variants (2026-11-19, dynamic targeting). A campaign file in
 * `landing/src/content/campaigns/<id>.json` names a page, the URL values
 * that select it and the words that change (landing/src/lib/campaigns.ts).
 * The build writes its page to `/_campaign/<id>/`. In landing mode, a GET
 * or HEAD of the campaign's page whose URL selects it (`?campaign=<id>`, or
 * a `match` such as `utm_campaign=dentists-*`) is answered with that page's
 * HTML, at the visitor's own URL: the server picks, so nothing flickers,
 * and the ad's URL stays in the address bar for analytics. A URL that
 * selects no campaign gets the base page. App-first mode has no campaigns.
 *
 * Edge copy (2026-11-19). `/_landing/manifest.json` lists every file of the
 * build with its hash, the page routes and the campaigns, so the platform
 * can copy the site to the edge before the app sleeps (LANDING_MANIFEST_PATH
 * below). Landing mode only.
 */

import type { Context, MiddlewareHandler } from "hono";
import { serveStatic } from "hono/deno";
import { APP_BASE_PATH, appPath } from "@/config/site.ts";
import { log } from "@/lib/logger.ts";
import { isSignedInMember } from "@/api/middleware/auth.ts";
import {
  type Campaign,
  campaignPagePath,
  campaignPath,
  parseCampaigns,
  selectCampaign,
} from "../../landing/src/lib/campaigns.ts";

/** Where `npm run build` in landing/ writes the site, relative to the repo root. */
export const LANDING_DIST_DIR = "./landing/dist";

/** The landing copy file. Its optional `homepage` field picks the mode. */
export const LANDING_SITE_JSON = "./landing/src/content/site.json";

/** The campaign files, relative to the repo root. */
export const LANDING_CAMPAIGNS_DIR = "./landing/src/content/campaigns";

/** What "/" serves: the landing site (default) or the app. */
export type HomepageMode = "landing" | "app";

/**
 * Read `homepage` from site.json. "app" means app-first; a missing file or
 * field means "landing". An unknown value also means "landing", with a
 * warning, so a typo never takes the homepage away silently.
 */
export function readHomepageMode(file: string = LANDING_SITE_JSON): HomepageMode {
  let value: unknown;
  try {
    value = JSON.parse(Deno.readTextFileSync(file))?.homepage;
  } catch {
    return "landing";
  }
  if (value === "app") return "app";
  if (value !== undefined && value !== "landing") {
    log.warn('site.json "homepage" must be "landing" or "app"; serving the landing site', {
      source: "landing-site",
      feature: "homepage-mode",
      value: String(value),
    });
  }
  return "landing";
}

/**
 * Read the campaign files. The build already failed on a bad file, so a
 * problem here means the file changed after the build: skip it and warn.
 * A missing folder means no campaigns.
 */
export function readCampaigns(dir: string = LANDING_CAMPAIGNS_DIR): Campaign[] {
  const files: { file: string; data: unknown }[] = [];
  let entries: Deno.DirEntry[];
  try {
    entries = [...Deno.readDirSync(dir)];
  } catch {
    return [];
  }
  for (const e of entries) {
    if (!e.isFile || !e.name.endsWith(".json")) continue;
    const file = `src/content/campaigns/${e.name}`;
    try {
      files.push({ file, data: JSON.parse(Deno.readTextFileSync(`${dir}/${e.name}`)) });
    } catch {
      files.push({ file, data: null });
    }
  }
  const { campaigns, problems } = parseCampaigns(files);
  if (problems.length > 0) {
    log.warn("landing campaigns skipped", {
      source: "landing-site",
      feature: "campaigns",
      problems: problems.join("; "),
    });
  }
  return campaigns;
}

/**
 * The built HTML of each campaign, keyed by id. A campaign whose page is
 * not in the build (built before the file was added) is left out.
 */
export function loadCampaignPages(dir: string, campaigns: Campaign[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const c of campaigns) {
    try {
      out.set(c.id, Deno.readTextFileSync(`${dir}${campaignPath(c.id)}index.html`));
    } catch {
      log.warn("landing campaign has no built page; serving the base page", {
        source: "landing-site",
        feature: "campaigns",
        campaign: c.id,
      });
    }
  }
  return out;
}

// ── Edge copy manifest ──

/**
 * The path of the landing manifest: everything the platform needs to keep
 * a copy of the landing site at the edge, so a visitor to a sleeping app
 * (Builder projects scale to zero when idle) gets the page instead of a
 * waking screen. The platform reads it from the awake app just before the
 * app sleeps, copies the listed files, and the Cloudflare Worker serves
 * them, picking campaigns with the same rules (landing/src/lib/campaigns.ts).
 * Landing mode only: in app-first mode "/" needs the app, so there is no
 * manifest (404).
 */
export const LANDING_MANIFEST_PATH = "/_landing/manifest.json";

/** One file of the landing build. */
export interface LandingManifestFile {
  /** The file's request path: "/index.html", "/_astro/site.css". */
  file: string;
  /** Its Content-Type. */
  type: string;
  size: number;
  /** Hex SHA-256 of the bytes. */
  sha256: string;
}

export interface LandingManifest {
  version: 1;
  /** Hex SHA-256 over every file's path and hash: changes when any file does. */
  build: string;
  files: LandingManifestFile[];
  /** Request path -> file path for each HTML page ("/" -> "/index.html", "/about/" and "/about/index.html" -> "/about/index.html"). */
  routes: Record<string, string>;
  /** The campaigns whose page is in the build, in the order the server tries them. */
  campaigns: Campaign[];
}

const CONTENT_TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  json: "application/json; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  xml: "application/xml; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  ico: "image/x-icon",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  pdf: "application/pdf",
  webmanifest: "application/manifest+json",
  mp4: "video/mp4",
  webm: "video/webm",
};

/** The Content-Type of a landing file, by request path. */
export function landingContentType(path: string): string {
  const known = LANDING_EXTENSIONLESS_TYPES[path];
  if (known) return known;
  const ext = path.split("/").pop()?.split(".").slice(1).pop()?.toLowerCase() ?? "";
  return CONTENT_TYPES[ext] ?? "application/octet-stream";
}

async function sha256Hex(bytes: Uint8Array<ArrayBuffer> | string): Promise<string> {
  const data = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Build the manifest of a landing build. A missing dir gives an empty one. */
export async function buildLandingManifest(
  dir: string,
  campaigns: Campaign[],
): Promise<LandingManifest> {
  const paths: string[] = [];
  const walk = (rel: string) => {
    let entries: Deno.DirEntry[];
    try {
      entries = [...Deno.readDirSync(`${dir}${rel}`)];
    } catch {
      return;
    }
    for (const e of entries) {
      const path = `${rel}/${e.name}`;
      if (e.isDirectory) walk(path);
      else if (e.isFile) paths.push(path);
    }
  };
  walk("");
  paths.sort();
  const files: LandingManifestFile[] = [];
  const routes: Record<string, string> = {};
  for (const path of paths) {
    const bytes = await Deno.readFile(`${dir}${path}`);
    files.push({
      file: path,
      type: landingContentType(path),
      size: bytes.byteLength,
      sha256: await sha256Hex(bytes),
    });
    if (!/\.html?$/i.test(path)) continue;
    // "/index.html" is the SPA shell (isLandingPath), never a landing route.
    if (path !== "/index.html") routes[path] = path;
    const name = path.split("/").pop() ?? "";
    if (/^index\.html?$/i.test(name)) {
      const rel = path.slice(0, -name.length);
      routes[rel] = path;
    } else {
      routes[path.replace(/\.html?$/i, "")] = path;
    }
  }
  const build = await sha256Hex(files.map((f) => `${f.file}:${f.sha256}`).join("\n"));
  const built = new Set(files.map((f) => f.file));
  return {
    version: 1,
    build,
    files,
    routes,
    campaigns: campaigns.filter((c) => built.has(`${campaignPath(c.id)}index.html`)),
  };
}

/** True when the landing site is built: `<dir>/index.html` exists. */
export function landingSiteBuilt(dir: string = LANDING_DIST_DIR): boolean {
  try {
    return Deno.statSync(`${dir}/index.html`).isFile;
  } catch {
    return false;
  }
}

/**
 * Paths the landing site never answers. `/api/*` keeps its JSON errors,
 * `/index.html` stays the SPA shell (the demo landing links to it), and the
 * SPA prefix belongs to the SPA.
 */
export function isLandingPath(path: string): boolean {
  if (path.startsWith("/api/") || path === "/api") return false;
  if (path === "/index.html") return false;
  if (APP_BASE_PATH && (path === APP_BASE_PATH || path.startsWith(`${APP_BASE_PATH}/`))) {
    return false;
  }
  return true;
}

/** What a landing build holds, split for app-first mode. */
export interface LandingFiles {
  /** Request paths of non-HTML files ("/llms.txt", "/_astro/x.css"). */
  files: Set<string>;
  /** Request paths of HTML pages, in every form that reaches them ("/about", "/about/", "/about/index.html"). */
  pages: Set<string>;
}

/** Walk a landing build once. A missing or unreadable dir yields empty sets. */
export function scanLandingDist(dir: string = LANDING_DIST_DIR): LandingFiles {
  const files = new Set<string>();
  const pages = new Set<string>();
  const walk = (rel: string) => {
    let entries: Iterable<Deno.DirEntry>;
    try {
      entries = Deno.readDirSync(`${dir}${rel}`);
    } catch {
      return;
    }
    for (const e of entries) {
      const path = `${rel}/${e.name}`;
      if (e.isDirectory) {
        walk(path);
        continue;
      }
      if (!e.isFile) continue;
      if (!/\.html?$/i.test(e.name)) {
        files.add(path);
        continue;
      }
      pages.add(path);
      if (/^index\.html?$/i.test(e.name)) {
        pages.add(`${rel}/`);
        if (rel) pages.add(rel);
      } else {
        pages.add(path.replace(/\.html?$/i, ""));
      }
    }
  };
  walk("");
  return { files, pages };
}

/**
 * Content types for landing files with no extension, by request path.
 * /.well-known/api-catalog (RFC 9727) is the API catalog the landing build
 * writes when site.json has `agents` (landing/src/lib/agent-facts.ts).
 */
export const LANDING_EXTENSIONLESS_TYPES: Readonly<Record<string, string>> = {
  "/.well-known/api-catalog": "application/linkset+json",
};

function setLandingContentType(_file: string, c: Context): void {
  const type = LANDING_EXTENSIONLESS_TYPES[c.req.path];
  if (type) c.header("Content-Type", type);
}

/**
 * The landing site middleware, or null when `landing/dist` is not built.
 * Checked once at boot: neither the build nor the mode can change in a
 * running pod. With null, "/" falls through to the SPA shell in app.ts.
 *
 * Landing mode serves every file in the build. App-first mode serves only
 * the non-HTML files, redirects the HTML pages to "/" and passes "/" and
 * everything else on to the SPA.
 */
/** Where a signed-in visitor who opens "/" goes: the app home. */
export const SIGNED_IN_HOME = appPath("/#/");

/** Whether this request carries a signed-in session. Injectable for tests. */
export type SignedInCheck = (c: Context) => Promise<boolean>;

export function landingSiteMiddleware(
  dir: string = LANDING_DIST_DIR,
  mode: HomepageMode = readHomepageMode(),
  signedIn: SignedInCheck = isSignedInMember,
  campaignList: Campaign[] = readCampaigns(),
): MiddlewareHandler | null {
  if (!landingSiteBuilt(dir)) return null;
  const serve = serveStatic({ root: dir, onFound: setLandingContentType });
  if (mode === "app") {
    const { files, pages } = scanLandingDist(dir);
    return async (c, next) => {
      const path = c.req.path;
      if (path === "/" || !isLandingPath(path)) return await next();
      if (files.has(path)) return await serve(c, next);
      if (pages.has(path)) return c.redirect("/", 302);
      return await next();
    };
  }
  const campaignPages = loadCampaignPages(dir, campaignList);
  let manifest: Promise<LandingManifest> | null = null;
  const campaigns = campaignList.filter((c) => campaignPages.has(c.id));
  const campaignPaths = new Set(campaigns.map((c) => c.page));
  return async (c, next) => {
    const path = c.req.path;
    if (!isLandingPath(path)) return await next();
    const read = c.req.method === "GET" || c.req.method === "HEAD";
    if (path === LANDING_MANIFEST_PATH && read) {
      manifest ??= buildLandingManifest(dir, campaignList);
      c.header("Cache-Control", "no-store");
      return c.json(await manifest);
    }
    if (path === "/" && read) {
      // The answer depends on the session cookie: never share it in a cache.
      c.header("Vary", "Cookie");
      if (await signedIn(c)) {
        c.header("Cache-Control", "private, no-store");
        return c.redirect(SIGNED_IN_HOME, 302);
      }
    }
    if (read && campaignPaths.size > 0 && !path.endsWith(".html")) {
      const query = new URL(c.req.url).searchParams;
      const page = campaignPagePath(path);
      const campaign = campaignPaths.has(page) && query.size > 0
        ? selectCampaign(campaigns, page, query)
        : null;
      const html = campaign ? campaignPages.get(campaign.id) : undefined;
      if (campaign && html) {
        c.header("X-Landing-Campaign", campaign.id);
        return c.html(html);
      }
    }
    return await serve(c, next);
  };
}
