/**
 * Template conformance check: is this repository still on the Chipp app
 * template's stack?
 *
 *   deno task conformance            human summary, exit 1 on an error
 *   deno task conformance --json     machine-readable report on stdout
 *
 * Why it exists: Chipp hosts apps built on this template, and the platform
 * is built around its stack. Postgres through Kysely, Redis, the Hono server,
 * the structured logger (its NDJSON lines feed Chipp's error detection and
 * self-healing) and the Chipp Insights beacon are what Chipp scales, watches
 * and repairs. An app that swaps one of them out still runs, but Chipp can no
 * longer see or fix it. So:
 *
 *   ERROR   = a stack swap: another web or frontend framework, ORM or
 *             database client, logger, error-reporting or analytics SDK, or a
 *             template core file removed or bypassed. Chipp refuses to
 *             publish a NEW error (see "Baseline" below).
 *   WARNING = smaller drift: console.* in server code, direct Deno.env reads,
 *             raw SQL clients outside src/db/, a stack SDK as a dev-only
 *             dependency, missing agent guides. Publish goes ahead and the
 *             warnings come back in the publish result.
 *   ROUTE ACCESS = an API route that reads or writes data must be behind the
 *             template auth or role middleware, or be marked public with a
 *             reason, and a public route must not return personal fields.
 *             A NEW or CHANGED violation is an error; a case the check cannot
 *             decide is a warning. See "Route access" below.
 *
 * The rules target the stack, not dependencies in general: a PDF library or a
 * date library is fine. The full rule table and how to fix each finding are
 * in docs/conventions/stack-and-conformance.md.
 *
 * The SAME file runs in two places and must stay byte-identical:
 *   - this repo:   scripts/conformance.ts (`deno task conformance`), so a
 *                  coding agent sees the result before it pushes;
 *   - Chipp build: alchemist-infra/customer-build/conformance.ts in the Chipp
 *                  platform repo. The build runs its own copy, so deleting or
 *                  editing this file does not change the publish gate. A
 *                  nightly platform check compares the two copies.
 *
 * Baseline (platform only): `--baseline <key,key,...>` or `--baseline '*'`
 * marks errors that were already live before this check existed. Those are
 * reported as `grandfathered` and do not block. Without `--baseline`, every
 * error blocks.
 *
 * Constraints: no imports (the build sandbox runs it with `--allow-read`
 * only and no network), no type checker, deterministic output (sorted walk,
 * sorted findings), and fast (it reads only text source files and skips
 * node_modules, build output and docs).
 *
 * Exit codes: 0 = nothing blocks, 1 = at least one blocking error,
 * 2 = usage error or the check itself crashed.
 */

const REPORT_VERSION = 1;
/** Rule families in this version: "stack" (sections 1-5), "route-auth" (section 6). */
const CHECKS = ["stack", "route-auth"] as const;
const DOCS_URL =
  "https://github.com/chipp-ai/alchemist-template/blob/staging/docs/conventions/stack-and-conformance.md";

type Severity = "error" | "warning";

export interface ConformanceFinding {
  /** Stable id `<rule>:<subject>`. The platform baseline stores these. */
  key: string;
  rule: string;
  severity: Severity;
  message: string;
  fix: string;
  file?: string;
  line?: number;
}

export interface ConformanceReport {
  tool: "chipp-template-conformance";
  version: number;
  /** True when no error blocks (warnings and grandfathered errors pass). */
  ok: boolean;
  errors: ConformanceFinding[];
  warnings: ConformanceFinding[];
  /** Keys of errors that block publish. */
  blocking: string[];
  /** Keys of errors that were live before the check and do not block. */
  grandfathered: string[];
  /** Which rule families ran. The platform baseline grandfathers a family a
   *  project's newest stored report did not have yet. */
  checks: string[];
  /** GET routes the platform's live exposure probe may call without a
   *  session (see `livenessProbeTargets`). Paths only. */
  probeTargets: string[];
  filesScanned: number;
  docs: string;
}

// ── Rule tables ─────────────────────────────────────────────────────────────
// A name ending in "/" matches every package under that scope or path.

interface StackRule {
  rule: string;
  what: string;
  keep: string;
  names: string[];
}

const STACK_RULES: StackRule[] = [
  {
    rule: "stack.web-framework",
    what: "another server or full-stack web framework",
    keep: "the template's Hono server (app.ts, src/api/routes/)",
    names: [
      "express", "fastify", "koa", "koa-router", "@koa/", "@nestjs/", "next", "nuxt",
      "@remix-run/", "@react-router/", "elysia", "@elysiajs/", "oak", "@oak/oak",
      "deno.land/x/oak", "deno.land/x/fresh", "@fresh/core", "@sveltejs/kit", "restify",
      "@hapi/hapi", "hapi", "sails", "@adonisjs/", "h3", "nitropack", "polka", "@feathersjs/",
      "@loopback/", "@tanstack/start", "@tanstack/react-start", "@solidjs/start",
      "@analogjs/", "gatsby", "@angular/ssr", "morgan", "body-parser",
    ],
  },
  {
    rule: "stack.frontend-framework",
    what: "another frontend framework",
    keep: "Svelte 5 in web/ (and Astro only in landing/)",
    names: [
      "react", "react-dom", "preact", "vue", "@angular/core", "solid-js", "@builder.io/qwik",
      "inferno", "mithril", "ember-source",
    ],
  },
  {
    rule: "stack.db-client",
    what: "another ORM or database client",
    keep: "Kysely on Postgres (src/db/client.ts) and the template's Redis helpers (src/lib/redis.ts)",
    names: [
      "prisma", "@prisma/client", "drizzle-orm", "typeorm", "sequelize", "sequelize-typescript",
      "mongoose", "mongodb", "knex", "objection", "@mikro-orm/", "pg", "pg-promise", "pg-pool",
      "mysql", "mysql2", "better-sqlite3", "sqlite3", "@libsql/client", "@supabase/supabase-js",
      "firebase", "firebase-admin", "@planetscale/database", "@neondatabase/serverless",
      "@vercel/postgres", "@vercel/kv", "deno.land/x/postgres", "@db/postgres",
      "deno.land/x/mysql", "deno.land/x/sqlite", "@db/sqlite", "ioredis", "redis",
      "@redis/client", "@upstash/redis",
    ],
  },
  {
    rule: "stack.logger",
    what: "another logger",
    keep: "`log` from src/lib/logger.ts (its NDJSON lines feed Chipp error detection and self-healing)",
    names: [
      "pino", "pino-http", "pino-pretty", "winston", "bunyan", "log4js", "loglevel", "consola",
      "signale", "tslog", "@logtape/logtape", "@std/log", "deno.land/std/log", "roarr", "npmlog",
    ],
  },
  {
    rule: "stack.error-reporting",
    what: "an error-reporting or APM SDK",
    keep: "the template's error handling (AppError + app.onError + log.error); Chipp reads those errors",
    names: [
      "@sentry/", "@bugsnag/", "rollbar", "@honeybadger-io/", "newrelic", "dd-trace", "@datadog/",
      "raygun", "raygun4js", "trackjs", "@highlight-run/", "highlight.run", "logrocket",
      "@airbrake/", "elastic-apm-node", "@elastic/apm-rum", "@appsignal/",
    ],
  },
  {
    rule: "stack.analytics",
    what: "another analytics SDK",
    keep: "Chipp Insights (src/lib/chipp-insights.ts, web/src/lib/chipp-insights.ts)",
    names: [
      "posthog-js", "posthog-node", "mixpanel", "mixpanel-browser", "@mixpanel/", "@segment/",
      "analytics-node", "@amplitude/", "amplitude-js", "@vercel/analytics", "@vercel/speed-insights",
      "react-ga", "react-ga4", "vue-gtag", "@google-analytics/", "plausible-tracker",
      "@fullstory/", "@hotjar/", "@june-so/", "@rudderstack/", "@heap/",
    ],
  },
];

/** Script hosts that load a third-party analytics or error tool in a page. */
const SCRIPT_HOSTS: Array<{ rule: string; host: string }> = [
  { rule: "stack.analytics", host: "googletagmanager.com" },
  { rule: "stack.analytics", host: "google-analytics.com" },
  { rule: "stack.analytics", host: "plausible.io/js" },
  { rule: "stack.analytics", host: "cdn.segment.com" },
  { rule: "stack.analytics", host: "i.posthog.com" },
  { rule: "stack.analytics", host: "app.posthog.com" },
  { rule: "stack.analytics", host: "cdn.mxpnl.com" },
  { rule: "stack.analytics", host: "static.hotjar.com" },
  { rule: "stack.analytics", host: "cdn.amplitude.com" },
  { rule: "stack.analytics", host: "clarity.ms" },
  { rule: "stack.analytics", host: "cdn.heapanalytics.com" },
  { rule: "stack.analytics", host: "edge.fullstory.com" },
  { rule: "stack.analytics", host: "cdn.usefathom.com" },
  { rule: "stack.analytics", host: "scripts.simpleanalyticscdn.com" },
  { rule: "stack.error-reporting", host: "browser.sentry-cdn.com" },
  { rule: "stack.error-reporting", host: "js.sentry-cdn.com" },
];

/** Packages allowed only in one folder (Astro runs the public site in landing/). */
const ALLOWED_ONLY_UNDER: Record<string, string> = { astro: "landing/", "@astrojs/": "landing/" };

/** Template core files. Missing one is a swap of that part of the stack. */
const CORE_FILES: Array<{ path: string; role: string }> = [
  { path: "deno.json", role: "the Deno project config" },
  { path: "main.ts", role: "the server entry point" },
  { path: "app.ts", role: "the Hono app and its error handler" },
  { path: "src/lib/logger.ts", role: "the structured logger" },
  { path: "src/lib/env.ts", role: "the env reader" },
  { path: "src/db/client.ts", role: "the Kysely database client" },
  { path: "db/migrate.ts", role: "the migration entry point" },
  { path: "src/lib/chipp-insights.ts", role: "the Chipp Insights server module" },
  { path: "src/api/middleware/chipp-insights.ts", role: "the Insights beacon middleware" },
  { path: "web/src/lib/chipp-insights.ts", role: "the Insights browser module" },
  { path: "src/api/routes/auth/index.ts", role: "the sign-in routes" },
];

/** Base files whose removal is drift, not a swap. */
const BASE_FILES: Array<{ path: string; role: string }> = [
  { path: "web/src/routes.ts", role: "the SPA route table" },
  { path: "web/src/components/Sidebar.svelte", role: "the app sidebar" },
  { path: ".alchemist/deployment.yaml", role: "the deploy declarations" },
  { path: "CLAUDE.md", role: "the agent guide index" },
  { path: "AGENTS.md", role: "the guide for outside coding agents" },
];

/** Template files that may use console.* (the logger itself, dev-only output). */
const CONSOLE_ALLOWED = [
  "src/lib/logger.ts",
  "src/observability/",
  "src/api/routes/auth/index.ts",
  "src/services/email-transport.ts",
];

const SKIP_DIRS = new Set([
  "node_modules", ".git", ".scratch", "dist", "build", ".svelte-kit", ".astro", ".vite",
  "coverage", "docs", "vendor", ".deno", ".cache", "worktrees", ".claude", ".chipp", ".github",
  ".output", ".next", ".nuxt", "tmp",
]);
const CODE_EXT = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".svelte", ".astro", ".vue"];
const PAGE_EXT = [".html", ".svelte", ".astro", ".vue", ".jsx", ".tsx"];
const MAX_FILES = 20000;
const MAX_FILE_BYTES = 1_000_000;

// ── Helpers ─────────────────────────────────────────────────────────────────

function stripJsonComments(text: string): string {
  // Good enough for deno.jsonc: drops // and /* */ comments outside strings.
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      out += ch;
      if (ch === "\\") {
        out += text[++i] ?? "";
      } else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
    } else if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (ch === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++;
    } else out += ch;
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

function parseJson(text: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(stripJsonComments(text));
    return v && typeof v === "object" ? v as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

/**
 * The package a specifier names: `npm:@sentry/deno@8/x` -> `@sentry/deno`,
 * `https://deno.land/x/oak@v12/mod.ts` -> `deno.land/x/oak`,
 * `https://esm.sh/react@18` -> `react`. Null for relative and local paths.
 */
export function packageOf(specifier: string): string | null {
  let s = specifier.trim();
  if (!s || s.startsWith(".") || s.startsWith("/") || s.startsWith("@/") || s.startsWith("$")) return null;
  if (s.startsWith("node:") || s.startsWith("data:") || s.startsWith("file:")) return null;
  if (/^https?:\/\//.test(s)) {
    const url = s.replace(/^https?:\/\//, "");
    const [host, ...rest] = url.split("/");
    const path = rest.join("/");
    if (host === "deno.land" && path.startsWith("x/")) {
      return `deno.land/x/${path.slice(2).split("/")[0].split("@")[0]}`;
    }
    if (host === "deno.land" && path.startsWith("std")) {
      const seg = path.split("/")[1];
      return seg ? `deno.land/std/${seg}` : "deno.land/std";
    }
    if (host === "jsr.io") s = path;
    else if (host === "cdn.jsdelivr.net" && path.startsWith("npm/")) s = path.slice(4);
    else if (["esm.sh", "cdn.skypack.dev", "unpkg.com", "esm.run", "ga.jspm.io"].includes(host)) {
      s = path.replace(/^npm:/, "");
    } else return host;
  }
  s = s.replace(/^(npm|jsr):\/?/, "");
  if (s.startsWith("@")) {
    const [scope, name] = s.split("/");
    if (!name) return null;
    return `${scope}/${name.split("@")[0]}`;
  }
  return s.split("/")[0].split("@")[0] || null;
}

function matches(name: string, pattern: string): boolean {
  return pattern.endsWith("/") ? name.startsWith(pattern) : name === pattern;
}

function stackRuleFor(name: string): { rule: StackRule; pattern: string } | null {
  for (const rule of STACK_RULES) {
    for (const pattern of rule.names) if (matches(name, pattern)) return { rule, pattern };
  }
  return null;
}

function lineOf(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

const IMPORT_RE =
  /(?:^|[\s;])(?:import|export)\s[^"'`;]*?from\s*["']([^"']+)["']|(?:^|[\s;(])import\s*\(\s*["']([^"']+)["']\s*\)|(?:^|[\s;])import\s+["']([^"']+)["']|\brequire\(\s*["']([^"']+)["']\s*\)/gm;

// ── Route access ────────────────────────────────────────────────────────────
//
// Rule (Hunter, 2026-11-26): every API route that reads or writes data goes
// through the template's auth or role middleware, or is marked public with a
// reason, and a public route returns no personal data. Why: in a scan of
// 159,041 Lovable apps about 30% leaked their users' email addresses. Chipp
// apps never hand the browser a database key, but the coding agent still
// writes each app's API routes, and one GET route without an auth check leaks
// the same way. This is a deterministic source check, so it runs on every
// publish (the build's conformance step), not only on tickets.
//
// A route counts as GUARDED when any of these is true:
//   - its own registration lists an auth middleware: requireAuth,
//     requireCapability(...), requireRole(...), any `require<Auth word>`
//     middleware, or a credential middleware (a name with Auth, Token,
//     Signature, Hmac, ApiKey, Bearer or Secret in it, or verify...);
//   - the same kind of middleware is registered with `<router>.use(...)`
//     BEFORE the route, on its own router or on a parent router before the
//     `.route()` mount, with a path that covers the route (Hono runs
//     middleware in registration order, so a later `use` does not count);
//   - an inline `use` middleware or the handler itself rejects callers: it
//     calls getUser(c), throws UnauthorizedError or ForbiddenError, returns a
//     401 or 403, or verifies a token or signature.
// Optional middleware (authMiddleware, optionalSession, optional*) only reads
// a session and never counts.
//
// A route is PUBLIC when its registration lists `publicRoute("<reason>")`
// (src/api/middleware/route-access.ts) or the line above it is a
// `// chipp:public <reason>` comment. A public route must give a reason and
// must not select or return personal fields (email, phone, address, names,
// date of birth, tokens, passwords, keys; `selectAll()` counts).
//
// Findings (keys carry a short hash of the route's source, so CHANGING an old
// unguarded route makes a new key and is checked again):
//   ERROR   route-auth.unguarded       an API route that touches data, with no guard
//   ERROR   route-auth.public-reason   publicRoute() / chipp:public with no reason
//   ERROR   route-auth.public-personal a public route that returns personal fields
//   WARNING route-auth.uncertain       the check could not tell (router not mounted
//                                      from app.ts, a path built at runtime, a handler
//                                      defined in another file)
// Routes in the template's own files (TEMPLATE_ROUTE_FILES) are Chipp's code,
// reviewed in the template repo, and are listed but never flagged.

/** Template-owned route code: Chipp reviews it in the template repo itself. */
const TEMPLATE_ROUTE_FILES = [
  "app.ts",
  "src/api/routes/agent-mcp/",
  "src/api/routes/api-keys/",
  "src/api/routes/assistants/",
  "src/api/routes/auth/",
  "src/api/routes/billing/",
  "src/api/routes/chipp-payments/",
  "src/api/routes/demo-landing.ts",
  "src/api/routes/dev/",
  "src/api/routes/docs/",
  "src/api/routes/email/",
  "src/api/routes/email-feedback/",
  "src/api/routes/events/",
  "src/api/routes/files/",
  "src/api/routes/health/",
  "src/api/routes/imports/",
  "src/api/routes/inbound-emails/",
  "src/api/routes/ingest-email/",
  "src/api/routes/invite/",
  "src/api/routes/mailing/",
  "src/api/routes/mcp/",
  "src/api/routes/observability/",
  "src/api/routes/org/",
  "src/api/routes/platform/",
  "src/api/routes/portal/",
  "src/api/routes/realtime/",
  "src/api/routes/site-forms/",
  "src/api/routes/storage-local/",
  "src/api/routes/unsubscribe/",
  "src/api/routes/well-known.ts",
  "src/services/headless-api/",
  "src/services/mcp-protocol/",
  "src/services/mcp-oauth/",
  "src/services/embedded-agent/",
];

const ROUTE_METHODS = new Set(["get", "post", "put", "patch", "delete", "all", "on"]);
const IDENT = "[A-Za-z_$][\\w$]*";

/** A middleware or handler name that authenticates the caller. */
const AUTH_WORDS =
  "Auth|Session|User|Login|Role|Capability|Permission|Admin|Owner|Staff|Member|Org|Team|Portal|Platform|" +
  "Super|Operator|Signed|Plan|Entitlement|Scope|Agent|Api|Key|Token|Verified|Authenticated|Access";
/** A middleware or handler name that authenticates the caller: requireAuth, requireChippStaff, requireAppRole, ... */
const AUTH_NAME_RE = new RegExp(
  `^(?:require\\w*(?:${AUTH_WORDS})\\w*|isAuthenticated|ensureAuth\\w*|authRequired|` +
    "\\w*(?:Auth|Token|Signature|Hmac|HMAC|ApiKey|Apikey|Bearer|Secret)(?:Middleware|Guard|Gate|Check)?|" +
    "verify\\w+|basicAuth|bearerAuth|jwt)$",
);
/** The same names called inside an inline middleware or handler (`return await requireChippStaff(c, next)`). */
const AUTH_CALL_RE = new RegExp(`\\b(?:require\\w*(?:${AUTH_WORDS})\\w*|verify\\w*(?:Token|Signature|Session|Secret|Key)\\w*)\\s*\\(`);
/** Reads a session when there is one; never rejects, so never a guard. */
const OPTIONAL_NAME_RE = /^(?:optional\w*|maybe\w*|soft\w*|authMiddleware|attach\w*|load\w*|populate\w*|resolveOptional\w*|withOptional\w*)$/;
/** Code that rejects an unauthenticated caller. */
const REJECTS_RE =
  /\bgetUser\s*\(|\bUnauthorizedError\b|\bForbiddenError\b|\b(?:status|code)\s*[:=(]\s*40[13]\b|,\s*40[13]\s*\)|\brequireAuth\b|\bverify\w*\s*\(|\btimingSafeEqual\b/;
/** Code that reads or writes data (or calls something that might). */
const TOUCHES_DATA_RE =
  /\b(?:db|trx|tx|kysely)\s*\.|\.\s*(?:selectFrom|insertInto|updateTable|deleteFrom|selectAll|executeTakeFirst\w*|execute)\s*\(|\bsql\s*`|\bawait\b/;
/** Field names that are personal data when a public route returns them. */
const PERSONAL_FIELD_RE =
  /\b(email|emails|e_mail|emailAddress|email_address|phone|phoneNumber|phone_number|mobile|address|streetAddress|street_address|street|postalCode|postal_code|zipCode|zip_code|firstName|first_name|lastName|last_name|fullName|full_name|dateOfBirth|date_of_birth|dob|birthDate|birth_date|ssn|passwordHash|password_hash|password|accessToken|access_token|refreshToken|refresh_token|apiKey|api_key|secret|ipAddress|ip_address)\b/gi;

export interface RouteInfo {
  file: string;
  line: number;
  method: string;
  /** Full path when the mount chain from app.ts resolved, else the router-local path. */
  path: string | null;
  /** True when the router is reachable from app.ts through `.route()` mounts. */
  mounted: boolean;
  guard: "auth" | "inline" | "public" | "none";
  /** What guards it (middleware name, "getUser", "inline check") or the public reason. */
  guardBy?: string;
  touchesData: boolean;
  /** Personal field names the route selects or returns ("*" = selectAll). */
  personalFields: string[];
  templateOwned: boolean;
  /** True when the handler body was not found (a function from another file). */
  handlerUnseen: boolean;
  /** FNV-1a of the registration source, so a changed route gets a new key. */
  hash: string;
}

/** Index of the last character of a string, template, comment or regex starting at i; i when none starts there. */
function skipToken(text: string, i: number): number {
  const ch = text[i];
  if (ch === "/" && text[i + 1] === "/") {
    const nl = text.indexOf("\n", i);
    return nl < 0 ? text.length - 1 : nl - 1;
  }
  if (ch === "/" && text[i + 1] === "*") {
    const end = text.indexOf("*/", i + 2);
    return end < 0 ? text.length - 1 : end + 1;
  }
  if (ch === '"' || ch === "'") {
    for (let j = i + 1; j < text.length; j++) {
      if (text[j] === "\\") j++;
      else if (text[j] === ch || text[j] === "\n") return j;
    }
    return text.length - 1;
  }
  if (ch === "`") {
    for (let j = i + 1; j < text.length; j++) {
      if (text[j] === "\\") j++;
      else if (text[j] === "`") return j;
      else if (text[j] === "$" && text[j + 1] === "{") {
        const end = matchBracket(text, j + 1);
        if (end < 0) return text.length - 1;
        j = end;
      }
    }
    return text.length - 1;
  }
  if (ch === "/") {
    // A regex literal, when the previous significant character cannot end an operand.
    let k = i - 1;
    while (k >= 0 && /\s/.test(text[k])) k--;
    const prev = k >= 0 ? text[k] : "";
    const prevWord = /\w/.test(prev) ? (text.slice(0, k + 1).match(/(\w+)$/)?.[1] ?? "") : "";
    if (prev === "" || "(,=:[!&|?{};+-*%<>~^".includes(prev) || ["return", "typeof", "case"].includes(prevWord)) {
      let inClass = false;
      for (let j = i + 1; j < text.length; j++) {
        const c = text[j];
        if (c === "\n") return i;
        if (c === "\\") j++;
        else if (c === "[") inClass = true;
        else if (c === "]") inClass = false;
        else if (c === "/" && !inClass) return j;
      }
    }
  }
  return i;
}

/** Index of the bracket that closes the one at `open`, or -1. */
function matchBracket(text: string, open: number): number {
  const close: Record<string, string> = { "(": ")", "[": "]", "{": "}" };
  const stack: string[] = [];
  for (let i = open; i < text.length; i++) {
    const skipped = skipToken(text, i);
    if (skipped !== i) {
      i = skipped;
      continue;
    }
    const ch = text[i];
    if (close[ch]) stack.push(close[ch]);
    else if (ch === ")" || ch === "]" || ch === "}") {
      if (stack.pop() !== ch) return -1;
      if (stack.length === 0) return i;
    }
  }
  return -1;
}

/** Top-level comma-separated arguments between `open` and `close` (exclusive). */
function splitArgs(text: string, open: number, close: number): string[] {
  const args: string[] = [];
  let start = open + 1;
  for (let i = open + 1; i < close; i++) {
    const skipped = skipToken(text, i);
    if (skipped !== i) {
      i = skipped;
      continue;
    }
    const ch = text[i];
    if (ch === "(" || ch === "[" || ch === "{") {
      const end = matchBracket(text, i);
      if (end < 0) break;
      i = end;
    } else if (ch === ",") {
      args.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  const last = text.slice(start, close).trim();
  if (last) args.push(last);
  return args;
}

/** The value of a string literal argument; null for anything computed. */
function literalString(arg: string | undefined): string | null {
  if (!arg) return null;
  const m = arg.match(/^(["'`])([^"'`$\\]*)\1$/);
  return m ? m[2] : null;
}

function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

function joinPath(prefix: string, path: string): string {
  const p = `${prefix.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
  return p.length > 1 ? p.replace(/\/+$/, "") || "/" : "/";
}

/** Does Hono path pattern `pattern` match (or cover) route path `path`? */
function patternCovers(pattern: string, path: string | null): boolean {
  if (pattern === "*" || pattern === "/*" || pattern === "/") return pattern !== "/" || path === "/";
  if (path === null) return false;
  const ps = pattern.split("/").filter(Boolean);
  const rs = path.split("/").filter(Boolean);
  for (let i = 0; i < ps.length; i++) {
    if (ps[i] === "*") return true;
    if (i >= rs.length) return false;
    if (ps[i].startsWith(":") || rs[i].startsWith(":")) continue;
    if (ps[i] !== rs[i]) return false;
  }
  return ps.length === rs.length;
}

interface UseEvent {
  kind: "use";
  router: string;
  index: number;
  path: string | null;
  args: string[];
}
interface RouteEvent {
  kind: "route";
  router: string;
  index: number;
  line: number;
  method: string;
  path: string | null;
  args: string[];
  source: string;
  marker: string | null;
}
interface MountEvent {
  kind: "mount";
  router: string;
  index: number;
  prefix: string | null;
  child: string;
}
type RouterEvent = UseEvent | RouteEvent | MountEvent;

interface FileModel {
  path: string;
  text: string;
  routers: Set<string>;
  events: RouterEvent[];
  /** local name -> [resolved file, exported name or "default"] */
  imports: Map<string, [string, string]>;
  /** exported name (or "default") -> local name */
  exports: Map<string, string>;
  /** local function or const name -> its source text */
  functions: Map<string, string>;
}

function resolveSpecifier(from: string, spec: string): string | null {
  let target: string;
  if (spec.startsWith("@/")) target = `src/${spec.slice(2)}`;
  else if (spec.startsWith("./") || spec.startsWith("../")) {
    const parts = from.split("/").slice(0, -1);
    for (const seg of spec.split("/")) {
      if (seg === "..") parts.pop();
      else if (seg !== ".") parts.push(seg);
    }
    target = parts.join("/");
  } else return null;
  return /\.(ts|js|mts|mjs)$/.test(target) ? target : `${target}.ts`;
}

function parseFileModel(path: string, text: string): FileModel {
  const model: FileModel = {
    path,
    text,
    routers: new Set(),
    events: [],
    imports: new Map(),
    exports: new Map(),
    functions: new Map(),
  };
  for (const m of text.matchAll(new RegExp(`\\b(export\\s+)?(?:const|let|var)\\s+(${IDENT})\\s*(?::[^=;]+)?=\\s*new\\s+(?:OpenAPI)?Hono\\b`, "g"))) {
    model.routers.add(m[2]);
    if (m[1]) model.exports.set(m[2], m[2]);
  }
  for (const m of text.matchAll(/^\s*import\s+(?!type\s)([\s\S]*?)\s+from\s+["']([^"']+)["']/gm)) {
    const file = resolveSpecifier(path, m[2]);
    if (!file) continue;
    const clause = m[1].trim();
    const braces = clause.match(/\{([\s\S]*)\}/);
    const def = clause.replace(/\{[\s\S]*\}/, "").replace(/,/g, " ").trim().split(/\s+/)[0];
    if (def && /^[A-Za-z_$][\w$]*$/.test(def)) model.imports.set(def, [file, "default"]);
    if (braces) {
      for (const part of braces[1].split(",")) {
        const [name, alias] = part.replace(/^\s*type\s+/, "").trim().split(/\s+as\s+/);
        if (name) model.imports.set((alias ?? name).trim(), [file, name.trim()]);
      }
    }
  }
  for (const m of text.matchAll(/\bexport\s*\{([^}]*)\}(?!\s*from)/g)) {
    for (const part of m[1].split(",")) {
      const [local, alias] = part.trim().split(/\s+as\s+/);
      if (local) model.exports.set((alias ?? local).trim(), local.trim());
    }
  }
  const def = text.match(new RegExp(`\\bexport\\s+default\\s+(${IDENT})\\s*;?\\s*$`, "m"));
  if (def) model.exports.set("default", def[1]);
  for (const m of text.matchAll(new RegExp(`\\b(?:async\\s+)?function\\s+(${IDENT})\\s*\\(|\\b(?:const|let)\\s+(${IDENT})\\s*(?::[^=;]+)?=\\s*`, "g"))) {
    const name = m[1] ?? m[2];
    const at = (m.index ?? 0) + m[0].length;
    const open = text.slice(at).search(/[({]/);
    if (open < 0 || open > 200) continue;
    let end = matchBracket(text, at + open);
    if (end < 0) continue;
    // An arrow function: the params were the first bracket, the body follows `=>`.
    const arrow = text.slice(end + 1).match(/^\s*(?::[^=]*?)?=>\s*/);
    if (arrow) {
      const bodyAt = end + 1 + arrow[0].length;
      if (text[bodyAt] === "{" || text[bodyAt] === "(") {
        const bodyEnd = matchBracket(text, bodyAt);
        if (bodyEnd > 0) end = bodyEnd;
      } else {
        const nl = text.indexOf("\n", bodyAt);
        end = nl < 0 ? text.length - 1 : nl;
      }
    } else if (m[1]) {
      // function name(params) { body }
      const bodyAt = text.indexOf("{", end);
      if (bodyAt > 0) {
        const bodyEnd = matchBracket(text, bodyAt);
        if (bodyEnd > 0) end = bodyEnd;
      }
    }
    if (!model.functions.has(name)) model.functions.set(name, text.slice(m.index ?? 0, end + 1));
  }
  if (model.routers.size === 0) return model;
  const callRe = new RegExp(`\\b(${IDENT})\\s*\\.\\s*(get|post|put|patch|delete|all|on|use|route)\\s*\\(`, "g");
  for (const m of text.matchAll(callRe)) {
    const router = m[1];
    if (!model.routers.has(router)) continue;
    const index = m.index ?? 0;
    // Skip matches inside comments or strings: the line up to the match has a // or an odd quote count.
    const lineStart = text.lastIndexOf("\n", index) + 1;
    const before = text.slice(lineStart, index);
    if (/\/\/|^\s*\*/.test(before)) continue;
    const open = index + m[0].length - 1;
    const close = matchBracket(text, open);
    if (close < 0) continue;
    const args = splitArgs(text, open, close);
    const verb = m[2];
    if (verb === "use") {
      const path = literalString(args[0]);
      const isPathArg = path !== null || /^[`"']/.test(args[0] ?? "") ||
        /^(?:prefix|path|base\w*)$|Path$|PATH$/.test(args[0] ?? "");
      model.events.push({ kind: "use", router, index, path: isPathArg ? path : "*", args: isPathArg ? args.slice(1) : args });
    } else if (verb === "route") {
      model.events.push({ kind: "mount", router, index, prefix: literalString(args[0]), child: (args[1] ?? "").trim() });
    } else if (ROUTE_METHODS.has(verb)) {
      let method = verb.toUpperCase();
      let rest = args;
      if (verb === "on") {
        method = (literalString(args[0]) ?? "ON").toUpperCase();
        rest = args.slice(1);
      }
      if (rest.length < 2) continue;
      const prevLineEnd = lineStart - 1;
      const prevLine = prevLineEnd > 0 ? text.slice(text.lastIndexOf("\n", prevLineEnd - 1) + 1, prevLineEnd) : "";
      const marker = prevLine.match(/\/\/\s*chipp:public\b(.*)$/);
      model.events.push({
        kind: "route",
        router,
        index,
        line: lineOf(text, index),
        method,
        path: literalString(rest[0]),
        args: rest.slice(1),
        source: text.slice(index, close + 1),
        marker: marker ? marker[1].trim() : null,
      });
    }
  }
  return model;
}

/** How one middleware argument guards, or null when it does not. */
function middlewareGuard(arg: string, model: FileModel): { by: string; public?: string } | null {
  const a = arg.replace(/^\.\.\./, "").trim();
  const pub = a.match(/^publicRoute\s*\(\s*(?:(["'`])([\s\S]*?)\1)?\s*\)$/);
  if (pub) return { by: "publicRoute", public: (pub[2] ?? "").trim() };
  const head = a.match(new RegExp(`^(${IDENT})`))?.[1] ?? "";
  if (head && OPTIONAL_NAME_RE.test(head)) return null;
  if (head && AUTH_NAME_RE.test(head)) return { by: head };
  if (/^(?:async\s*)?(?:\(|function\b|[A-Za-z_$][\w$]*\s*=>)/.test(a) || /^createMiddleware\s*\(/.test(a)) {
    return REJECTS_RE.test(a) || AUTH_CALL_RE.test(a) ? { by: "inline check" } : null;
  }
  const body = head ? model.functions.get(head) : undefined;
  if (body && (REJECTS_RE.test(body) || AUTH_CALL_RE.test(body))) return { by: head };
  return null;
}

function personalFieldsIn(code: string): string[] {
  const found = new Set<string>();
  if (/\.\s*selectAll\s*\(/.test(code)) found.add("*");
  const scopes: string[] = [];
  for (const m of code.matchAll(/\.\s*(?:select|returning)\s*\(|\bc\.json\s*\(/g)) {
    const open = (m.index ?? 0) + m[0].length - 1;
    const close = matchBracket(code, open);
    if (close > open) scopes.push(code.slice(open, close + 1));
  }
  for (const s of scopes) for (const f of s.matchAll(PERSONAL_FIELD_RE)) found.add(f[1]);
  return [...found].sort();
}

/**
 * Every route registration in the repo, with how it is guarded. Pure: takes
 * the server source files (repo-relative path -> text). The live exposure
 * scanner on the platform reads the same list to pick what to probe.
 */
export function analyzeRoutes(files: Map<string, string>): RouteInfo[] {
  const models = new Map<string, FileModel>();
  for (const [path, text] of files) {
    if (!/\.(ts|js|mts|mjs)$/.test(path)) continue;
    if (path.includes("__tests__/") || /\.test\.(ts|js)$/.test(path)) continue;
    if (path !== "app.ts" && !path.startsWith("src/")) continue;
    models.set(path, parseFileModel(path, text));
  }
  interface Ctx {
    prefix: string | null;
    inherited: Array<{ pattern: string; by: string; public?: string }>;
  }
  const contexts = new Map<string, Ctx[]>();
  const resolveChild = (model: FileModel, ident: string): string | null => {
    if (model.routers.has(ident)) return `${model.path}#${ident}`;
    const imp = model.imports.get(ident);
    if (!imp) return null;
    const target = models.get(imp[0]) ?? models.get(imp[0].replace(/\.ts$/, "/index.ts"));
    if (!target) return null;
    const local = target.exports.get(imp[1]) ?? (target.routers.has(imp[1]) ? imp[1] : null);
    return local && target.routers.has(local) ? `${target.path}#${local}` : null;
  };
  const visit = (key: string, ctx: Ctx, depth: number) => {
    if (depth > 12) return;
    const list = contexts.get(key) ?? [];
    if (list.some((c) => c.prefix === ctx.prefix)) return;
    list.push(ctx);
    contexts.set(key, list);
    const [file, router] = key.split("#");
    const model = models.get(file)!;
    const uses: Ctx["inherited"] = [...ctx.inherited];
    for (const ev of model.events) {
      if (ev.router !== router) continue;
      if (ev.kind === "use") {
        for (const arg of ev.args) {
          const g = middlewareGuard(arg, model);
          if (!g) continue;
          // A `use` with a computed path counts as covering everything: the
          // check leans to "guarded" there, and the live probe covers the rest.
          const wide = ev.path === null || ev.path === "*" || ev.path === "/*";
          const pattern = wide ? joinPath(ctx.prefix ?? "", "*") : joinPath(ctx.prefix ?? "", ev.path!);
          uses.push({ pattern, ...g });
        }
      } else if (ev.kind === "mount") {
        const child = resolveChild(model, ev.child);
        if (!child) continue;
        const prefix = ctx.prefix === null || ev.prefix === null ? null : joinPath(ctx.prefix, ev.prefix);
        visit(child, { prefix, inherited: [...uses] }, depth + 1);
      }
    }
  };
  const app = models.get("app.ts");
  if (app) for (const r of app.routers) visit(`app.ts#${r}`, { prefix: "", inherited: [] }, 0);

  const routes: RouteInfo[] = [];
  for (const model of models.values()) {
    for (const router of model.routers) {
      const key = `${model.path}#${router}`;
      const ctxs = contexts.get(key) ?? [{ prefix: null, inherited: [] }];
      const mounted = contexts.has(key);
      for (const ctx of ctxs) {
        const own: Ctx["inherited"] = [];
        for (const ev of model.events) {
          if (ev.router !== router) continue;
          if (ev.kind === "use") {
            for (const arg of ev.args) {
              const g = middlewareGuard(arg, model);
              if (g) own.push({ pattern: ev.path === null || ev.path === "*" || ev.path === "/*" ? "*" : ev.path, ...g });
            }
            continue;
          }
          if (ev.kind !== "route") continue;
          const local = ev.path;
          const full = local === null ? null : ctx.prefix === null ? local : joinPath(ctx.prefix, local);
          let guard: RouteInfo["guard"] = "none";
          let guardBy: string | undefined;
          const pubFromMarker = ev.marker !== null ? ev.marker : undefined;
          for (const arg of ev.args.slice(0, -1)) {
            const g = middlewareGuard(arg, model);
            if (!g) continue;
            if (g.public !== undefined) {
              guard = "public";
              guardBy = g.public;
              break;
            }
            if (guard === "none") {
              guard = "auth";
              guardBy = g.by;
            }
          }
          if (pubFromMarker !== undefined && guard === "none") {
            guard = "public";
            guardBy = pubFromMarker;
          }
          if (guard === "none") {
            const hit = [...ctx.inherited.filter((u) => patternCovers(u.pattern, full)),
              ...own.filter((u) => patternCovers(u.pattern, local))].find((u) => u.public === undefined);
            if (hit) {
              guard = "auth";
              guardBy = hit.by;
            }
          }
          const handlerArg = ev.args[ev.args.length - 1] ?? "";
          const handlerName = handlerArg.match(new RegExp(`^(${IDENT})$`))?.[1];
          const handlerBody = handlerName ? model.functions.get(handlerName) : handlerArg;
          const handlerUnseen = handlerName !== undefined && handlerBody === undefined;
          // Local helpers the handler calls (one level), so a handler that
          // delegates to a function in the same file is still read.
          let code = handlerBody ?? "";
          for (const call of code.matchAll(new RegExp(`\\b(${IDENT})\\s*\\(`, "g"))) {
            const fn = model.functions.get(call[1]);
            if (fn && fn !== handlerBody && code.length < 200_000) code += `\n${fn}`;
          }
          if (guard === "none" && handlerBody !== undefined) {
            if (/\bgetUser\s*\(/.test(handlerBody)) {
              guard = "auth";
              guardBy = "getUser";
            } else if (REJECTS_RE.test(handlerBody) || AUTH_CALL_RE.test(handlerBody)) {
              guard = "inline";
              guardBy = "inline check";
            }
          }
          routes.push({
            file: model.path,
            line: ev.line,
            method: ev.method,
            path: full,
            mounted,
            guard,
            ...(guardBy !== undefined ? { guardBy } : {}),
            touchesData: handlerUnseen || TOUCHES_DATA_RE.test(code),
            personalFields: personalFieldsIn(code),
            templateOwned: TEMPLATE_ROUTE_FILES.some((p) => model.path === p || (p.endsWith("/") && model.path.startsWith(p))),
            handlerUnseen,
            hash: fnv1a(ev.source.replace(/\s+/g, " ")),
          });
        }
      }
    }
  }
  return routes.sort((a, b) =>
    a.file.localeCompare(b.file) || a.line - b.line || (a.path ?? "").localeCompare(b.path ?? "")
  );
}

/** GET paths that may trigger work when called, so the live probe never calls them. */
const SIDE_EFFECT_PATH_RE =
  /(logout|log-out|login|signin|sign-in|signup|callback|webhook|unsubscribe|tick|cron|trigger|send|\brun\b|reset|seed|sync|delete|remove|confirm|verify|approve|cancel|accept|claim|redeem|stream|sse|\/ws\b|realtime|oauth|authorize|token|impersonate|wake)/i;

/**
 * The routes the platform's recurring exposure probe calls WITHOUT a session
 * (src/alchemist/services/exposure-scan/). The build stores this list on the
 * deploy row, so the probe never reads the repo. Only GET, only a literal
 * path with no `:param` or `*`, only under /api/, never /api/dev/ and never a
 * path whose name suggests it does something (logout, webhook, send, ...).
 * Sorted, unique, capped at 100.
 */
export function livenessProbeTargets(routes: RouteInfo[]): string[] {
  const out = new Set<string>();
  for (const r of routes) {
    if (r.method !== "GET" || !r.path || !r.mounted) continue;
    if (!r.path.startsWith("/api/") || r.path.startsWith("/api/dev/") || /[:*]/.test(r.path)) continue;
    if (SIDE_EFFECT_PATH_RE.test(r.path)) continue;
    out.add(r.path);
  }
  return [...out].sort().slice(0, 100);
}

/** The conformance findings for a route list (see "Route access" above). */
export function routeAccessFindings(routes: RouteInfo[]): Array<Omit<ConformanceFinding, "key"> & { subject: string }> {
  const out: Array<Omit<ConformanceFinding, "key"> & { subject: string }> = [];
  const safe = (s: string) => s.replace(/[^A-Za-z0-9._:/@+-]/g, "_");
  for (const r of routes) {
    if (r.templateOwned) continue;
    const api = r.path === null ? r.file.startsWith("src/api/") : r.path.startsWith("/api/") || r.path === "/api";
    if (!api) continue;
    const where = `${r.file}:${r.line}`;
    const label = `${r.method} ${r.path ?? "(path built at runtime)"}`;
    const subject = `${safe(`${r.method}${r.path ?? `${r.file}:${r.line}`}`)}@${r.hash}`;
    if (r.guard === "public") {
      if (!r.guardBy) {
        out.push({
          rule: "route-auth.public-reason",
          subject,
          severity: "error",
          message: `${label} (${where}) is marked public with no reason.`,
          fix: 'Say why anyone on the internet may call it: publicRoute("contact form submissions") or `// chipp:public contact form submissions`. If only signed-in users need it, use requireAuth instead.',
          file: r.file,
          line: r.line,
        });
      }
      const personal = r.personalFields;
      if (personal.length > 0) {
        out.push({
          rule: "route-auth.public-personal",
          subject,
          severity: "error",
          message: `${label} (${where}) is public and selects or returns personal fields (${personal.join(", ")}).`,
          fix: personal.includes("*")
            ? "Replace selectAll() with the exact non-personal columns the public page needs, or put the route behind requireAuth."
            : `Drop ${personal.filter((f) => f !== "*").join(", ")} from what this route selects and returns, or put it behind requireAuth (and requireCapability for role checks).`,
          file: r.file,
          line: r.line,
        });
      }
      continue;
    }
    if (r.guard !== "none" || !r.touchesData) continue;
    const certain = r.mounted && r.path !== null && !r.handlerUnseen;
    out.push({
      rule: certain ? "route-auth.unguarded" : "route-auth.uncertain",
      subject,
      severity: certain ? "error" : "warning",
      message: certain
        ? `${label} (${where}) reads or writes data and anyone can call it: no auth middleware covers it and it is not marked public.`
        : `${label} (${where}) has no auth check this check can see (${
          !r.mounted ? "its router is not mounted from app.ts" : r.path === null ? "the path is built at runtime" : "the handler is defined in another file"
        }).`,
      fix: "Put it behind the template auth: add requireAuth to the route (or `<router>.use(\"*\", requireAuth)` before its routes), plus requireCapability(\"...\") when only some roles may call it. " +
        'If it must be open to anyone, mark it public: publicRoute("<why it is public>") as its first middleware (src/api/middleware/route-access.ts), or, in a project without that file, a `// chipp:public <why it is public>` comment on the line above the route. A public route returns no personal fields.',
      file: r.file,
      line: r.line,
    });
  }
  return out;
}

// ── The check ───────────────────────────────────────────────────────────────

export interface RunOptions {
  root: string;
  /** Error keys that were already live; `"*"` grandfathers every error. */
  baseline?: Set<string> | "*";
}

export async function runConformance(opts: RunOptions): Promise<ConformanceReport> {
  const root = opts.root.replace(/\/+$/, "") || ".";
  const findings = new Map<string, ConformanceFinding>();
  const add = (f: Omit<ConformanceFinding, "key"> & { subject: string }) => {
    const key = `${f.rule}:${f.subject}`;
    if (findings.has(key)) return;
    const { subject: _subject, ...rest } = f;
    findings.set(key, { key, ...rest });
  };

  const readText = async (rel: string): Promise<string | null> => {
    try {
      const info = await Deno.stat(`${root}/${rel}`);
      if (!info.isFile || info.size > MAX_FILE_BYTES) return null;
      return await Deno.readTextFile(`${root}/${rel}`);
    } catch {
      return null;
    }
  };

  // Walk the tree once, sorted, so the output is deterministic.
  const files: string[] = [];
  const packageJsons: string[] = [];
  const walk = async (dir: string) => {
    if (files.length >= MAX_FILES) return;
    let entries: Deno.DirEntry[] = [];
    try {
      for await (const e of Deno.readDir(dir ? `${root}/${dir}` : root)) entries.push(e);
    } catch {
      return;
    }
    entries = entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      const rel = dir ? `${dir}/${e.name}` : e.name;
      if (e.isDirectory) {
        if (!SKIP_DIRS.has(e.name)) await walk(rel);
      } else if (e.isFile) {
        if (e.name === "package.json") packageJsons.push(rel);
        if ([...CODE_EXT, ".html"].some((x) => e.name.endsWith(x))) files.push(rel);
        if (files.length >= MAX_FILES) return;
      }
    }
  };
  await walk("");

  // Import map from deno.json(c): resolves bare aliases ("redis" -> deno.land/x/redis).
  const denoJsonText = (await readText("deno.json")) ?? (await readText("deno.jsonc"));
  const denoJson = denoJsonText ? parseJson(denoJsonText) : null;
  const importMap: Record<string, string> = {};
  const rawImports = denoJson?.imports;
  if (rawImports && typeof rawImports === "object") {
    for (const [k, v] of Object.entries(rawImports as Record<string, unknown>)) {
      if (typeof v === "string") importMap[k] = v;
    }
  }
  const resolve = (spec: string): string => {
    if (importMap[spec]) return importMap[spec];
    for (const [k, v] of Object.entries(importMap)) {
      if (k.endsWith("/") && spec.startsWith(k)) return v + spec.slice(k.length);
    }
    return spec;
  };

  const flagPackage = (
    name: string,
    where: string,
    line: number | undefined,
    devOnly: boolean,
  ) => {
    for (const [pattern, folder] of Object.entries(ALLOWED_ONLY_UNDER)) {
      if (matches(name, pattern)) {
        if (where.startsWith(folder)) return;
        add({
          rule: "stack.frontend-framework",
          subject: name,
          severity: devOnly ? "warning" : "error",
          message: `${name} is used outside ${folder} (${where}).`,
          fix: `Keep ${name} in ${folder}; the app UI is Svelte 5 in web/.`,
          file: where,
          line,
        });
        return;
      }
    }
    const hit = stackRuleFor(name);
    if (!hit) return;
    if (devOnly) {
      add({
        rule: "drift.dev-dependency",
        subject: name,
        severity: "warning",
        message: `${name} (${hit.rule.what}) is a dev dependency in ${where}.`,
        fix: `Remove it unless a build tool needs it. The app uses ${hit.rule.keep}.`,
        file: where,
      });
      return;
    }
    add({
      rule: hit.rule.rule,
      subject: name,
      severity: "error",
      message: `${name} is ${hit.rule.what} (${where}${line ? `:${line}` : ""}).`,
      fix: `Remove ${name} and use ${hit.rule.keep}.`,
      file: where,
      line,
    });
  };

  // 1. Runtime and core files.
  if (!denoJson) {
    add({
      rule: "stack.runtime",
      subject: "deno.json",
      severity: "error",
      message: denoJsonText ? "deno.json is not valid JSON." : "deno.json is missing: this is no longer a Deno app.",
      fix: "Restore deno.json from the template. Chipp builds and runs the app with Deno.",
      file: "deno.json",
    });
  }
  for (const core of CORE_FILES) {
    if (core.path === "deno.json") continue;
    if ((await readText(core.path)) === null) {
      add({
        rule: "core.missing",
        subject: core.path,
        severity: "error",
        message: `${core.path} (${core.role}) is missing.`,
        fix: `Restore ${core.path} from the template and build on it instead of replacing it.`,
        file: core.path,
      });
    }
  }
  for (const base of BASE_FILES) {
    if ((await readText(base.path)) === null) {
      add({
        rule: "drift.base-file-missing",
        subject: base.path,
        severity: "warning",
        message: `${base.path} (${base.role}) is missing.`,
        fix: `Restore ${base.path} from the template.`,
        file: base.path,
      });
    }
  }

  // 2. Core files still wired in (not bypassed).
  const bypass = (subject: string, file: string, message: string, fix: string) =>
    add({ rule: "core.bypassed", subject, severity: "error", message, fix, file });
  const mainTs = await readText("main.ts");
  if (mainTs !== null && !/from\s+["']\.\/app\.ts["']/.test(mainTs)) {
    bypass("main.ts", "main.ts", "main.ts no longer imports the template app (./app.ts).",
      "Keep main.ts starting the Hono app from app.ts; add routes in src/api/routes/.");
  }
  const appTs = await readText("app.ts");
  if (appTs !== null) {
    if (!/new\s+Hono\b/.test(appTs)) {
      bypass("app.ts:hono", "app.ts", "app.ts no longer creates the Hono app.", "Restore app.ts from the template.");
    }
    if (!/\.onError\s*\(/.test(appTs)) {
      bypass("app.ts:onError", "app.ts", "app.ts no longer registers the template error handler (app.onError).",
        "Restore app.onError: it logs every unhandled error in the shape Chipp self-healing reads.");
    }
    if (!/chipp-insights/.test(appTs)) {
      bypass("app.ts:insights", "app.ts", "app.ts no longer mounts the Chipp Insights middleware.",
        "Restore the chipp-insights middleware in app.ts.");
    }
  }
  const loggerTs = await readText("src/lib/logger.ts");
  if (loggerTs !== null && !/export\s+const\s+log\b/.test(loggerTs)) {
    bypass("src/lib/logger.ts", "src/lib/logger.ts", "src/lib/logger.ts no longer exports `log`.",
      "Restore the template logger; its NDJSON output is what Chipp reads for errors.");
  }
  const clientTs = await readText("src/db/client.ts");
  if (clientTs !== null && !/\bKysely\b/.test(clientTs)) {
    bypass("src/db/client.ts", "src/db/client.ts", "src/db/client.ts no longer builds the Kysely client.",
      "Restore the Kysely client; query Postgres through it.");
  }

  // 3. Declared dependencies.
  for (const [alias, target] of Object.entries(importMap)) {
    const name = packageOf(target);
    if (name) flagPackage(name, "deno.json", undefined, false);
    else if (!alias.endsWith("/")) {
      const aliasName = packageOf(alias);
      if (aliasName && !target.startsWith(".")) flagPackage(aliasName, "deno.json", undefined, false);
    }
  }
  for (const rel of packageJsons) {
    const pkg = parseJson((await readText(rel)) ?? "");
    if (!pkg) continue;
    const dir = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/") + 1) : "";
    if (rel === "package.json") {
      add({
        rule: "drift.root-package-json",
        subject: "package.json",
        severity: "warning",
        message: "There is a package.json at the repository root.",
        fix: "Declare server dependencies in deno.json imports; web/ and landing/ have their own package.json.",
        file: rel,
      });
    }
    for (const field of ["dependencies", "optionalDependencies", "devDependencies"]) {
      const deps = pkg[field];
      if (!deps || typeof deps !== "object") continue;
      for (const name of Object.keys(deps as Record<string, unknown>).sort()) {
        flagPackage(name, `${dir}package.json`, undefined, field === "devDependencies");
      }
    }
  }

  // 4. Imports in source, script tags in pages, and drift in server code.
  const consoleHits: Array<{ file: string; line: number; count: number }> = [];
  const envHits: Array<{ file: string; line: number }> = [];
  for (const rel of files) {
    const text = await readText(rel);
    if (text === null) continue;
    if (!rel.endsWith(".html")) {
      for (const m of text.matchAll(IMPORT_RE)) {
        const spec = m[1] ?? m[2] ?? m[3] ?? m[4];
        if (!spec) continue;
        const name = packageOf(resolve(spec));
        if (!name) continue;
        const line = lineOf(text, m.index ?? 0);
        flagPackage(name, rel, line, false);
        if (name === "postgres" && rel.startsWith("src/") && !rel.startsWith("src/db/") &&
          !rel.startsWith("src/__tests__/")) {
          add({
            rule: "drift.raw-db-client",
            subject: rel,
            severity: "warning",
            message: `${rel}:${line} imports the raw postgres driver.`,
            fix: "Query through the Kysely client in src/db/client.ts so scoping and camelCase mapping apply.",
            file: rel,
            line,
          });
        }
      }
      const kv = text.search(/\bDeno\.openKv\s*\(/);
      if (kv >= 0 && !rel.startsWith("src/__tests__/")) {
        add({
          rule: "stack.db-client",
          subject: "Deno.openKv",
          severity: "error",
          message: `${rel}:${lineOf(text, kv)} opens Deno KV, a second database.`,
          fix: "Store data in Postgres through Kysely (src/db/client.ts), and use src/lib/redis.ts for cache.",
          file: rel,
          line: lineOf(text, kv),
        });
      }
    }
    if (PAGE_EXT.some((x) => rel.endsWith(x))) {
      for (const { rule, host } of SCRIPT_HOSTS) {
        const idx = text.indexOf(host);
        if (idx < 0) continue;
        const kind = STACK_RULES.find((r) => r.rule === rule)!;
        add({
          rule,
          subject: host,
          severity: "error",
          message: `${rel}:${lineOf(text, idx)} loads ${host} (${kind.what}).`,
          fix: `Remove the ${host} script and use ${kind.keep}.`,
          file: rel,
          line: lineOf(text, idx),
        });
      }
    }
    const serverCode = rel.startsWith("src/") && !rel.startsWith("src/__tests__/") &&
      /\.(ts|js|mts|mjs)$/.test(rel);
    if (serverCode && !CONSOLE_ALLOWED.some((p) => rel === p || (p.endsWith("/") && rel.startsWith(p)))) {
      const all = [...text.matchAll(/\bconsole\.(log|info|warn|error|debug)\s*\(/g)];
      if (all.length > 0) consoleHits.push({ file: rel, line: lineOf(text, all[0].index ?? 0), count: all.length });
    }
    if (serverCode && rel !== "src/lib/env.ts") {
      const idx = text.search(/\bDeno\.env\.(get|toObject|has)\s*\(/);
      if (idx >= 0) envHits.push({ file: rel, line: lineOf(text, idx) });
    }
  }
  for (const hit of consoleHits) {
    add({
      rule: "drift.console",
      subject: hit.file,
      severity: "warning",
      message: `${hit.file}:${hit.line} uses console.* ${hit.count} time(s) in server code.`,
      fix: "Use log.info / log.warn / log.error from src/lib/logger.ts. Console lines never reach Chipp error detection.",
      file: hit.file,
      line: hit.line,
    });
  }
  for (const hit of envHits) {
    add({
      rule: "drift.direct-env",
      subject: hit.file,
      severity: "warning",
      message: `${hit.file}:${hit.line} reads Deno.env directly.`,
      fix: "Use getEnv() from src/lib/env.ts.",
      file: hit.file,
      line: hit.line,
    });
  }

  // 5. Small config drift.
  const tasks = denoJson?.tasks as Record<string, unknown> | undefined;
  if (denoJson && !(tasks && typeof tasks.conformance === "string")) {
    add({
      rule: "drift.conformance-task-missing",
      subject: "deno.json",
      severity: "warning",
      message: "deno.json has no `conformance` task.",
      fix: 'Add "conformance": "deno run --no-config --no-lock --allow-read=. scripts/conformance.ts" to deno.json tasks.',
      file: "deno.json",
    });
  }
  if ((await readText("chipp-insights.json")) === null) {
    add({
      rule: "drift.insights-inactive",
      subject: "chipp-insights.json",
      severity: "warning",
      message: "chipp-insights.json is missing, so the Insights beacon is off.",
      fix: "Chipp writes this file when it creates the project. Start from start_project instead of a plain clone, or keep the file.",
      file: "chipp-insights.json",
    });
  }

  // 6. Route access: every data route is behind auth or marked public with a
  //    reason, and public routes return no personal fields ("Route access").
  const serverSources = new Map<string, string>();
  for (const rel of files) {
    if (rel !== "app.ts" && !rel.startsWith("src/")) continue;
    if (!/\.(ts|js|mts|mjs)$/.test(rel) || rel.startsWith("src/__tests__/")) continue;
    const text = await readText(rel);
    if (text !== null) serverSources.set(rel, text);
  }
  const routes = analyzeRoutes(serverSources);
  for (const f of routeAccessFindings(routes)) add(f);
  const probeTargets = livenessProbeTargets(routes);

  // Sort, split, apply the baseline.
  const all = [...findings.values()].sort((a, b) => a.key.localeCompare(b.key));
  const errors = all.filter((f) => f.severity === "error");
  const warnings = all.filter((f) => f.severity === "warning");
  const baseline = opts.baseline;
  // A baseline entry ending in "*" grandfathers every key with that prefix
  // ("route-auth.*" on the first build after the route check shipped).
  const prefixes = baseline instanceof Set ? [...baseline].filter((k) => k.endsWith("*")).map((k) => k.slice(0, -1)) : [];
  const isOld = (key: string) =>
    baseline === "*" || (baseline instanceof Set && (baseline.has(key) || prefixes.some((p) => key.startsWith(p))));
  const grandfathered = errors.filter((e) => isOld(e.key)).map((e) => e.key);
  const blocking = errors.filter((e) => !isOld(e.key)).map((e) => e.key);
  return {
    tool: "chipp-template-conformance",
    version: REPORT_VERSION,
    ok: blocking.length === 0,
    errors,
    warnings,
    blocking,
    grandfathered,
    checks: [...CHECKS],
    probeTargets,
    filesScanned: files.length,
    docs: DOCS_URL,
  };
}

/** The plain-text summary a person or a coding agent reads. */
export function formatSummary(report: ConformanceReport): string {
  const lines: string[] = [];
  const blocking = new Set(report.blocking);
  if (report.ok) {
    lines.push(
      report.errors.length === 0 && report.warnings.length === 0
        ? "Template conformance: OK. The app is on the Chipp template stack."
        : `Template conformance: OK to publish (${report.warnings.length} warning(s)${
          report.grandfathered.length ? `, ${report.grandfathered.length} grandfathered error(s)` : ""
        }).`,
    );
  } else {
    lines.push(
      `Template conformance: ${report.blocking.length} error(s). Chipp will not publish this commit until they are fixed.`,
    );
  }
  for (const e of report.errors) {
    const tag = blocking.has(e.key) ? "ERROR" : "ERROR (grandfathered, does not block)";
    lines.push(`${tag} [${e.rule}] ${e.message}`, `  Fix: ${e.fix}`);
  }
  for (const w of report.warnings) lines.push(`WARNING [${w.rule}] ${w.message}`, `  Fix: ${w.fix}`);
  if (report.errors.length || report.warnings.length) lines.push(`Rules and fixes: ${report.docs}`);
  return lines.join("\n");
}

function parseArgs(args: string[]): { root: string; json: boolean; baseline?: Set<string> | "*"; help: boolean } {
  let root = ".";
  let json = false;
  let help = false;
  let baseline: Set<string> | "*" | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const value = (flag: string) => {
      if (a.startsWith(`${flag}=`)) return a.slice(flag.length + 1);
      const v = args[++i];
      if (v === undefined) throw new Error(`${flag} needs a value`);
      return v;
    };
    if (a === "--json") json = true;
    else if (a === "--help" || a === "-h") help = true;
    else if (a === "--root" || a.startsWith("--root=")) root = value("--root");
    else if (a === "--baseline" || a.startsWith("--baseline=")) {
      const v = value("--baseline").trim();
      baseline = v === "*" ? "*" : new Set(v.split(",").map((s) => s.trim()).filter(Boolean));
    } else throw new Error(`unknown argument: ${a}`);
  }
  return { root, json, baseline, help };
}

if (import.meta.main) {
  try {
    const args = parseArgs(Deno.args);
    if (args.help) {
      console.log("Usage: deno run --allow-read scripts/conformance.ts [--json] [--root <dir>] [--baseline <keys|*>]");
      Deno.exit(0);
    }
    const report = await runConformance({ root: args.root, baseline: args.baseline });
    console.log(args.json ? JSON.stringify(report, null, 2) : formatSummary(report));
    Deno.exit(report.ok ? 0 : 1);
  } catch (err) {
    console.error(`conformance check failed to run: ${err instanceof Error ? err.message : String(err)}`);
    Deno.exit(2);
  }
}
