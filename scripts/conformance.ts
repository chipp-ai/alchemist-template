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
      fix: 'Add "conformance": "deno run --allow-read scripts/conformance.ts" to deno.json tasks.',
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

  // Sort, split, apply the baseline.
  const all = [...findings.values()].sort((a, b) => a.key.localeCompare(b.key));
  const errors = all.filter((f) => f.severity === "error");
  const warnings = all.filter((f) => f.severity === "warning");
  const baseline = opts.baseline;
  const isOld = (key: string) => baseline === "*" || (baseline instanceof Set && baseline.has(key));
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
