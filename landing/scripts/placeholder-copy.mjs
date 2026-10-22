// Factory placeholder copy must never ship.
//
// A new project gets a first draft of src/content/site.json: the template's
// own "Your product" copy, or the factory seed's fallback sentences when the
// brief had too little to say. Both are scaffolding. Once the project has
// its own app pages, the landing site at "/" must say what the product
// really is. Two of three pilot projects shipped the scaffold at "/" and
// put the real homepage at /app/#/.
//
// Run by `npm test` (scripts/placeholder-copy.test.mjs), which reads the
// real site.json and ../web/src/routes.

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, relative } from "node:path";

// The template's own placeholder name. site.json still holding it means the
// repo is the template itself, or a project nobody has named yet.
export const TEMPLATE_PLACEHOLDER_NAME = "Your product";

// The files web/src/routes has in a fresh template checkout. A project with
// any other route file has been built on, so it is no longer new.
// Keep in lockstep with the template: placeholder-copy.test.mjs fails in
// the template repo when this list and web/src/routes differ.
export const BASE_ROUTE_FILES = [
  "Dashboard.svelte",
  "Design.svelte",
  "Docs.svelte",
  "Import.svelte",
  "InboundEmailDetail.svelte",
  "InboundEmails.svelte",
  "InviteAccept.svelte",
  "Login.svelte",
  "NotFound.svelte",
  "ReviewQueue.svelte",
  "Settings.svelte",
  "Signup.svelte",
  "portal/PortalClaim.svelte",
  "portal/PortalHome.svelte",
];

// Sentences only scaffolding writes. The template's own copy, and the
// fallbacks of chipp-deno's landing-content-seed.service.ts.
const PLACEHOLDER_PATTERNS = [
  { re: /\bYour product\b/, why: 'the template name "Your product"' },
  { re: /helps a team do one job well/, why: "the template's sample definition" },
  { re: /It is for anyone who needs what .+ does\./, why: 'the seeded "who it is for" fallback' },
  { re: /runs in the browser, so there is nothing to install\./, why: 'the seeded "what it does" fallback' },
  { re: /is made by the team that runs it\./, why: 'the seeded "about" fallback' },
];

// "Acme is a web app." with nothing after it: the seed had no description.
const BARE_WHAT_RE = /^.+ is a (?:web app|website)\.$/;

/** Every string in a JSON value, with its dotted path. */
function strings(value, path = "") {
  if (typeof value === "string") return [[path, value]];
  if (Array.isArray(value)) return value.flatMap((v, i) => strings(v, `${path}[${i}]`));
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([k, v]) => strings(v, path ? `${path}.${k}` : k));
  }
  return [];
}

/** Placeholder sentences in a site.json object, as "path: reason" lines. */
export function findPlaceholderCopy(site) {
  const found = [];
  for (const [path, text] of strings(site)) {
    for (const { re, why } of PLACEHOLDER_PATTERNS) {
      if (re.test(text)) found.push(`${path}: ${why}`);
    }
  }
  if (typeof site?.definition?.what === "string" && BARE_WHAT_RE.test(site.definition.what.trim())) {
    found.push('definition.what: the seeded bare "is a web app." sentence');
  }
  return found;
}

/** Route files under a web/src/routes directory, relative and sorted. */
export function listRouteFiles(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(relative(dir, p).split("\\").join("/"));
    }
  };
  walk(dir);
  return out.sort();
}

/** True when the project has route files the template does not ship. */
export function projectIsBuiltOn(routeFiles) {
  return routeFiles.some((f) => !BASE_ROUTE_FILES.includes(f));
}

// The only two front ends the image builds and serves (Dockerfile): the SPA
// in web/ at /app and the landing site in landing/ at "/".
const DEPLOYED_FRONTENDS = ["web", "landing"];

/**
 * Top-level folders that look like a separate front end (their own
 * package.json or index.html). Nothing builds or serves them, so an app
 * written there never reaches the deployed URL.
 */
export function findStrayAppFolders(root) {
  return readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith(".") && !DEPLOYED_FRONTENDS.includes(e.name))
    .filter((e) => existsSync(join(root, e.name, "package.json")) || existsSync(join(root, e.name, "index.html")))
    .map((e) => e.name)
    .sort();
}

/** Read the real files. `root` is the repo root. */
export function loadRepoState(root) {
  const site = JSON.parse(readFileSync(join(root, "landing/src/content/site.json"), "utf8"));
  const routeFiles = listRouteFiles(join(root, "web/src/routes"));
  const strayAppFolders = findStrayAppFolders(root);
  return { site, routeFiles, strayAppFolders };
}
