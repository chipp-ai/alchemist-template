/**
 * Mobile guardrails (source-shape lints, no browser).
 *
 * Pins the mechanical half of the mobile rules in web/DESIGN.md
 * ("Mobile and touch") so every project generated from this template
 * keeps them:
 *
 *   1. Every viewport meta has viewport-fit=cover and never
 *      maximum-scale or user-scalable (both block pinch zoom).
 *   2. No `vh` unit in CSS. Use dvh (full-screen layouts, overlays) or
 *      svh (heroes). 100vh is taller than the visible screen on phones.
 *   3. `:hover` only inside `@media (hover: hover) and (pointer: fine)`.
 *      A bare :hover sticks after a tap on touch screens.
 *   4. Every `:hover` selector has an `:active` twin in the same file, so
 *      a tap gives feedback where hover never fires.
 *   5. Text fields render at 16px or more on touch screens. iOS zooms the
 *      page on focus below 16px. A smaller size is allowed only inside a
 *      desktop query: `@media (min-width: 769px) and (pointer: fine)`.
 *   6. app.css keeps the global touch rules (tap highlight, touch-action,
 *      overflow-x backstop, the .icon-btn 44px tap area), and the shipped
 *      icon-only buttons use .icon-btn.
 *
 * Scope: web/index.html, every web/src .svelte <style> block and .css
 * file, and every landing/src .astro <style> block. Viewport metas are
 * also checked in server-rendered pages under src/.
 */

import { assert } from "@std/assert";

function deno(name: string, fn: () => void | Promise<void>) {
  Deno.test({ name, sanitizeResources: false, sanitizeOps: false, fn });
}

const ROOT = new URL("../../", import.meta.url);
const read = (rel: string) => Deno.readTextFile(new URL(rel, ROOT));

async function walk(rel: string, exts: string[]): Promise<string[]> {
  const out: string[] = [];
  for await (const entry of Deno.readDir(new URL(rel, ROOT))) {
    const sub = `${rel}${entry.name}`;
    if (entry.isDirectory) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      out.push(...(await walk(`${sub}/`, exts)));
    } else if (exts.some((e) => entry.name.endsWith(e))) {
      out.push(sub);
    }
  }
  return out;
}

interface Source {
  rel: string;
  /** Full file text (markup + style). */
  text: string;
  /** CSS to lint: the whole file for .css, the <style> blocks otherwise. */
  css: string;
}

function styleBlocks(text: string): string {
  return [...text.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join("\n");
}

async function cssSources(): Promise<Source[]> {
  const files = [
    "web/index.html",
    ...(await walk("web/src/", [".svelte", ".css"])),
    ...(await walk("landing/src/", [".astro"])),
  ];
  const out: Source[] = [];
  for (const rel of files) {
    const text = await read(rel);
    const css = rel.endsWith(".css") ? text : styleBlocks(text);
    if (css.trim()) out.push({ rel, text, css });
  }
  return out;
}

interface Rule {
  selector: string;
  body: string;
  /** Preludes of every enclosing at-rule, outermost first. */
  media: string[];
}

/** Minimal CSS walker: style rules with their enclosing at-rule preludes. */
export function parseRules(css: string): Rule[] {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const rules: Rule[] = [];
  const walkBlock = (start: number, end: number, media: string[]) => {
    let i = start;
    while (i < end) {
      const open = src.indexOf("{", i);
      if (open === -1 || open >= end) return;
      let depth = 0;
      let close = open;
      for (; close < end; close++) {
        if (src[close] === "{") depth++;
        else if (src[close] === "}" && --depth === 0) break;
      }
      // A prelude starts after the last `;` or `}` before the brace.
      const prelude = src.slice(i, open).split(/[;}]/).pop()!.trim();
      if (prelude.startsWith("@")) {
        walkBlock(open + 1, close, [...media, prelude]);
      } else {
        rules.push({
          selector: prelude.replace(/\s+/g, " "),
          body: src.slice(open + 1, close),
          media,
        });
      }
      i = close + 1;
    }
  };
  walkBlock(0, src.length, []);
  return rules;
}

const HOVER_QUERY = /\(hover:\s*hover\)\s*and\s*\(pointer:\s*fine\)/;
const isDesktopQuery = (m: string) => /min-width/.test(m) && /pointer:\s*fine/.test(m);

deno("mobile lint self-test: parseRules tracks nested at-rules", () => {
  const rules = parseRules(`
    a:hover { color: red; }
    @media (hover: hover) and (pointer: fine) { .b:hover { color: red; } }
    @media (min-width: 769px) and (pointer: fine) { @supports (x: y) { .c { font-size: 12px; } } }
  `);
  assert(rules.length === 3);
  assert(rules[0].selector === "a:hover" && rules[0].media.length === 0);
  assert(HOVER_QUERY.test(rules[1].media[0]));
  assert(rules[2].media.length === 2 && isDesktopQuery(rules[2].media[0]));
});

deno("mobile lint self-test: minPx reads the smallest rendered size", () => {
  assert(minPx("14px") === 14);
  assert(minPx("1rem") === 15, "1rem is 15px at the smallest design.json root");
  assert(minPx("var(--text-sm)")! < 16);
  assert(minPx("max(16px, var(--text-sm))") === 16);
  assert(minPx("var(--text-2xl)") === null);
});

deno("mobile: every viewport meta has viewport-fit=cover and allows pinch zoom", async () => {
  const files = [
    "web/index.html",
    ...(await walk("landing/src/", [".astro"])),
    ...(await walk("src/", [".ts"])).filter((f) => !f.startsWith("src/__tests__/")),
  ];
  const offenders: string[] = [];
  let metas = 0;
  for (const rel of files) {
    const text = await read(rel);
    if (/maximum-scale|user-scalable/i.test(text)) {
      offenders.push(`${rel}: maximum-scale / user-scalable blocks pinch zoom; remove it`);
    }
    for (const m of text.matchAll(/<meta\s+name=["']viewport["']\s+content=["']([^"']*)["']/g)) {
      metas++;
      if (!/viewport-fit=cover/.test(m[1])) {
        offenders.push(`${rel}: viewport meta "${m[1]}" lacks viewport-fit=cover`);
      }
    }
  }
  assert(metas >= 2, "expected the SPA and landing viewport metas to be found");
  assert(offenders.length === 0, offenders.join("\n"));
});

deno("mobile: no vh unit in CSS (use dvh for full-screen, svh for heroes)", async () => {
  const offenders: string[] = [];
  for (const { rel, css } of await cssSources()) {
    const clean = css.replace(/\/\*[\s\S]*?\*\//g, "");
    const hits = [...clean.matchAll(/(?<![\w-])\d*\.?\d+vh\b/g)].map((m) => m[0]);
    if (hits.length) offenders.push(`${rel}: ${hits.join(", ")}`);
  }
  assert(
    offenders.length === 0,
    `Replace vh with dvh or svh (web/DESIGN.md "Mobile and touch"):\n${offenders.join("\n")}`,
  );
});

deno("mobile: :hover only inside @media (hover: hover) and (pointer: fine)", async () => {
  const offenders: string[] = [];
  for (const { rel, css } of await cssSources()) {
    for (const r of parseRules(css)) {
      if (r.selector.includes(":hover") && !r.media.some((m) => HOVER_QUERY.test(m))) {
        offenders.push(`${rel}: ${r.selector}`);
      }
    }
  }
  assert(
    offenders.length === 0,
    `A bare :hover sticks after a tap on phones. Wrap it in ` +
      `@media (hover: hover) and (pointer: fine) { ... }:\n${offenders.join("\n")}`,
  );
});

/** Form fields: hover is a mouse affordance, :focus is their press state. */
const FIELD_SELECTOR = /(^|[\s>+~(,])(input|select|textarea)\b|\.(input|select|textarea)(?![\w-])/;

deno("mobile: every :hover selector has an :active twin in the same file", async () => {
  const offenders: string[] = [];
  for (const { rel, css } of await cssSources()) {
    const rules = parseRules(css);
    const selectors = new Set(rules.flatMap((r) => r.selector.split(",").map((s) => s.trim())));
    for (const r of rules) {
      for (const sel of r.selector.split(",").map((s) => s.trim())) {
        if (!sel.includes(":hover") || FIELD_SELECTOR.test(sel)) continue;
        const twin = sel.replaceAll(":hover", ":active");
        if (!selectors.has(twin)) offenders.push(`${rel}: ${sel} (add ${twin})`);
      }
    }
  }
  assert(
    offenders.length === 0,
    `Touch screens never show :hover, so each tappable element needs its own :active state:\n` +
      offenders.join("\n"),
  );
});

const TEXT_INPUT_TYPES = new Set([
  "",
  "text",
  "email",
  "tel",
  "url",
  "search",
  "password",
  "number",
  "date",
  "time",
  "datetime-local",
  "month",
  "week",
]);

/** Classes put on text fields in this file's markup (static class="..." only). */
function fieldClasses(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/<(input|select|textarea)\b([^>]*)>/g)) {
    const attrs = m[2];
    const type = attrs.match(/\stype=["']([^"']*)["']/)?.[1] ?? "";
    if (m[1] === "input" && !TEXT_INPUT_TYPES.has(type)) continue;
    const cls = attrs.match(/\sclass=["']([^"'{}]*)["']/)?.[1] ?? "";
    out.push(...cls.split(/\s+/).filter((c) => c && !["input", "select", "textarea"].includes(c)));
  }
  return out;
}

/** Smallest size, in px, a font-size value can render at (root 15px is the design.json floor). */
const ROOT_MIN_PX = 15;
const TEXT_TOKEN_REM: Record<string, number> = { xs: 0.64, sm: 0.8, base: 1 };
export function minPx(value: string): number | null {
  const v = value.trim();
  const max = v.match(/^max\((.*)\)$/);
  if (max) {
    const sizes = max[1].split(",").map(minPx).filter((n): n is number => n !== null);
    return sizes.length ? Math.max(...sizes) : null;
  }
  const px = v.match(/^([\d.]+)px$/);
  if (px) return Number(px[1]);
  const rem = v.match(/^([\d.]+)r?em$/);
  if (rem) return Number(rem[1]) * ROOT_MIN_PX;
  const token = v.match(/^var\(--text-(xs|sm|base)\b/);
  if (token) return TEXT_TOKEN_REM[token[1]] * ROOT_MIN_PX;
  return null; // larger tokens, inherit, clamp(): not judged here
}

deno("mobile: text fields are 16px or more outside a desktop-only query", async () => {
  const offenders: string[] = [];
  for (const { rel, text, css } of await cssSources()) {
    const classes = fieldClasses(text);
    const classRe = classes.length
      ? new RegExp(`\\.(${classes.map((c) => c.replace(/[-]/g, "\\-")).join("|")})(?![\\w-])`)
      : null;
    for (const r of parseRules(css)) {
      if (r.media.some(isDesktopQuery)) continue;
      const targetsField = r.selector.split(",").some((s) =>
        FIELD_SELECTOR.test(s) || (classRe?.test(s) ?? false)
      );
      if (!targetsField) continue;
      for (const m of r.body.matchAll(/(?:^|;|\s)font-size:\s*([^;]+)/g)) {
        const px = minPx(m[1]);
        if (px !== null && px < 16) {
          offenders.push(`${rel}: ${r.selector} { font-size: ${m[1].trim()} }`);
        }
      }
    }
  }
  assert(
    offenders.length === 0,
    `iOS zooms the page when a field under 16px gets focus. Use max(16px, ...) and put a ` +
      `smaller size only inside @media (min-width: 769px) and (pointer: fine):\n${
        offenders.join("\n")
      }`,
  );
});

deno("mobile: app.css keeps the global touch rules", async () => {
  const css = await read("web/src/app.css");
  const rules = parseRules(css);
  const has = (sel: RegExp, decl: RegExp) =>
    rules.some((r) => sel.test(r.selector) && decl.test(r.body));
  assert(
    has(/^html$/, /-webkit-tap-highlight-color:\s*transparent/),
    "html tap highlight transparent",
  );
  assert(
    has(/(^|,\s*)button(,|$)/, /touch-action:\s*manipulation/),
    "touch-action: manipulation on buttons",
  );
  assert(
    has(/(^|,\s*)a(,|$)/, /touch-action:\s*manipulation/),
    "touch-action: manipulation on links",
  );
  assert(has(/(^|,\s*)\.btn(,|$)/, /user-select:\s*none/), "user-select: none on controls");
  assert(!has(/^(body|html|p|main)$/, /user-select:\s*none/), "body text stays selectable");
  assert(has(/^html, body$/, /overflow-x:\s*clip/), "overflow-x: clip backstop on html/body");
  assert(
    has(/^\.icon-btn::before$/, /width:\s*max\(100%, 44px\)[\s\S]*height:\s*max\(100%, 44px\)/),
    ".icon-btn 44px tap area",
  );
  assert(has(/^body$/, /min-height:\s*100dvh/), "body min-height uses dvh");
});

deno("mobile: shipped icon-only buttons use .icon-btn", async () => {
  const cases: Array<[string, string]> = [
    ["web/src/components/Modal.svelte", 'class="icon-btn modal-close"'],
    ["web/src/components/ToastContainer.svelte", 'class="icon-btn toast-dismiss"'],
    ["web/src/components/ThemeToggle.svelte", 'class="icon-btn theme-toggle"'],
    ["web/src/components/Sidebar.svelte", 'class="btn btn-ghost icon-btn mobile-menu-btn"'],
  ];
  for (const [rel, needle] of cases) {
    assert((await read(rel)).includes(needle), `${rel} should contain ${needle}`);
  }
});

deno("mobile: fixed top bar and toasts clear the safe-area insets", async () => {
  const sidebar = await read("web/src/components/Sidebar.svelte");
  assert(sidebar.includes("height: calc(56px + env(safe-area-inset-top))"));
  const toasts = await read("web/src/components/ToastContainer.svelte");
  assert(toasts.includes("env(safe-area-inset-bottom)"));
});

deno("mobile: the agent guidance documents the rules", async () => {
  const design = await read("web/DESIGN.md");
  assert(design.includes("## Mobile and touch"), "web/DESIGN.md has a Mobile and touch section");
  const claude = await read("CLAUDE.md");
  assert(claude.includes("Mobile and touch"), "CLAUDE.md points at the mobile rules");
});
