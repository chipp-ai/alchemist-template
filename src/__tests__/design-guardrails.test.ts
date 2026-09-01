/**
 * Design-system S1 — guardrails slice (the "S5 layer" from
 * docs/design-system-program.md, landed in the same commit as the rest
 * of S1 per that doc's contract).
 *
 * This is the GENERAL-PURPOSE lint the other design-system test files
 * (design-tokens.test.ts, design-kit.test.ts, design-motion.test.ts,
 * design-dark-mode.test.ts) each explicitly deferred to a "separate S1
 * work item." It enforces, across every `web/src/.../*.svelte` `<style>`
 * block and every `web/src/.../*.css` file EXCEPT the token-definition
 * files themselves:
 *
 *   1. No raw hex color literal (`#rgb`/`#rrggbb`/`#rrggbbaa`) — colors
 *      must come from a `var(--...)` token.
 *   2. No `transition: all` / `transition-property: all`.
 *   3. No hardcoded `font-family` value — fonts must come from
 *      `var(--font-heading|--font-sans|--font-mono)`.
 *
 * Exemptions (documented in web/DESIGN.md):
 *   - web/src/app.css and web/src/motion.css: these ARE the token
 *     definition files — they're where hex literals are allowed to
 *     originate (every hex here backs a `--color-*`/`--brand-*` custom
 *     property that components consume via `var()`).
 *   - web/src/components/DevPanel.svelte: an agent/developer debugging
 *     tool, not a customer-facing product surface. It never renders in
 *     production (`import.meta.env.PROD` gate + Vite dead-code
 *     elimination) and is deliberately styled as fixed "devtool chrome"
 *     independent of the active brand/theme, so it does not participate
 *     in the token system.
 *   - Inline SVG `fill="#..."` attributes in component MARKUP (not
 *     `<style>` blocks) — e.g. the official multi-color Google "G"
 *     logo on the OAuth button. Those are fixed third-party trademark
 *     colors, not design decisions this app can derive from its brand
 *     palette. The lint only inspects `<style>` block contents, so
 *     markup-level `fill` attributes are out of scope by construction.
 */

import { assert } from "@std/assert";

function deno(name: string, fn: () => void | Promise<void>) {
  Deno.test({ name, sanitizeResources: false, sanitizeOps: false, fn });
}

const TOKEN_FILES = new Set([
  "web/src/app.css",
  "web/src/motion.css",
]);

const HEX_EXEMPT_FILES = new Set([
  ...TOKEN_FILES,
  "web/src/components/DevPanel.svelte",
]);

const FONT_FAMILY_EXEMPT_FILES = new Set([
  ...TOKEN_FILES,
  "web/src/components/DevPanel.svelte",
]);

async function walk(dir: URL): Promise<string[]> {
  const out: string[] = [];
  for await (const entry of Deno.readDir(dir)) {
    const sub = new URL(`${entry.name}${entry.isDirectory ? "/" : ""}`, dir);
    if (entry.isDirectory) {
      out.push(...(await walk(sub)));
    } else if (entry.name.endsWith(".svelte") || entry.name.endsWith(".css")) {
      out.push(sub.pathname);
    }
  }
  return out;
}

/** Extract the concatenated contents of every `<style>...</style>` block. */
function extractStyleBlocks(source: string): string {
  const blocks = [...source.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)];
  return blocks.map((m) => m[1]).join("\n");
}

interface CssFile {
  /** Repo-relative path, e.g. "web/src/app.css" or "web/src/routes/Login.svelte". */
  relPath: string;
  /** CSS to lint — the whole file for .css, extracted <style> blocks for .svelte. */
  css: string;
}

async function collectCssFiles(): Promise<CssFile[]> {
  const files = await walk(new URL("../../web/src/", import.meta.url));
  const out: CssFile[] = [];
  for (const path of files) {
    const relPath = "web/src/" + path.split("/web/src/")[1];
    const source = await Deno.readTextFile(path);
    const css = relPath.endsWith(".css") ? source : extractStyleBlocks(source);
    if (css.trim().length > 0) out.push({ relPath, css });
  }
  return out;
}

const HEX_LITERAL_RE = /#[0-9a-fA-F]{3,8}\b/g;

deno(
  "guardrail: no raw hex color literals outside token-definition files or DevPanel",
  async () => {
    const files = await collectCssFiles();
    const offenders: string[] = [];
    for (const { relPath, css } of files) {
      if (HEX_EXEMPT_FILES.has(relPath)) continue;
      const matches = [...css.matchAll(HEX_LITERAL_RE)];
      if (matches.length > 0) {
        offenders.push(`${relPath}: ${matches.map((m) => m[0]).join(", ")}`);
      }
    }
    assert(
      offenders.length === 0,
      `Raw hex color literal(s) found outside token-definition files. Use a ` +
        `var(--color-*) / var(--brand-*) token instead (see web/DESIGN.md):\n` +
        offenders.join("\n"),
    );
  },
);

deno("guardrail: no `transition: all` / `transition-property: all` anywhere", async () => {
  const files = await collectCssFiles();
  const re = /transition(?:-property)?\s*:\s*all\b/i;
  const offenders: string[] = [];
  for (const { relPath, css } of files) {
    if (re.test(css)) offenders.push(relPath);
  }
  assert(
    offenders.length === 0,
    `\`transition: all\` found (always list explicit properties — see ` +
      `web/DESIGN.md's motion conventions):\n${offenders.join("\n")}`,
  );
});

// A conservative match for a hardcoded font-family DECLARATION whose value
// is not exclusively `var(...)` references / `inherit` / `initial`. We
// intentionally do NOT flag `font-family` appearing inside a `var(--font-*,
// <fallback>)` default arg (that's how app.css itself is allowed to declare
// the token in the first place) — this lint only walks files OUTSIDE the
// token-definition set, so a plain `font-family: <literal>;` there is
// always a real regression.
const FONT_FAMILY_DECL_RE = /font-family\s*:\s*([^;]+);/g;

deno("guardrail: font-family is only ever set via a --font-* token", async () => {
  const files = await collectCssFiles();
  const offenders: string[] = [];
  for (const { relPath, css } of files) {
    if (FONT_FAMILY_EXEMPT_FILES.has(relPath)) continue;
    for (const match of css.matchAll(FONT_FAMILY_DECL_RE)) {
      const value = match[1].trim();
      const isTokenOnly = /^var\(\s*--font-(heading|sans|mono)\s*\)$/.test(value) ||
        value === "inherit" || value === "initial" || value === "unset";
      if (!isTokenOnly) {
        offenders.push(`${relPath}: font-family: ${value};`);
      }
    }
  }
  assert(
    offenders.length === 0,
    `font-family declared without a --font-* token. Reference ` +
      `var(--font-heading), var(--font-sans), or var(--font-mono) — never a ` +
      `literal family name (see web/DESIGN.md):\n${offenders.join("\n")}`,
  );
});

deno("guardrail: web/DESIGN.md exists and documents the token/motion/component rules", async () => {
  const text = await Deno.readTextFile(
    new URL("../../web/DESIGN.md", import.meta.url),
  );
  for (
    const needle of [
      "hex",
      "transition",
      "font-family",
      "prefers-reduced-motion",
      "--brand-primary",
    ]
  ) {
    assert(
      text.toLowerCase().includes(needle.toLowerCase()),
      `web/DESIGN.md should mention "${needle}"`,
    );
  }
});

deno("guardrail: CLAUDE.md references web/DESIGN.md", async () => {
  const text = await Deno.readTextFile(new URL("../../CLAUDE.md", import.meta.url));
  assert(text.includes("web/DESIGN.md"), "CLAUDE.md should link/reference web/DESIGN.md");
});
