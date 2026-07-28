/**
 * Design-system S1 — dark mode slice.
 *
 * Coverage:
 *   - web/src/lib/theme.ts: pure resolveInitialTheme()/nextTheme() logic —
 *     real unit tests (not source-shape lints), since this module has no
 *     Svelte runes and can be imported directly under Deno. Proves
 *     "default light" and the toggle logic without needing a browser.
 *   - Source-shape lints:
 *     - web/src/stores/theme.svelte.ts registers via defineStore, never
 *       reads prefers-color-scheme/matchMedia (no OS-auto theming), and
 *       persists to localStorage under the shared THEME_STORAGE_KEY.
 *     - web/index.html carries the anti-FOUC inline script that applies a
 *       persisted "dark" choice before first paint, and does not consult
 *       prefers-color-scheme either.
 *     - web/src/app.css defines `[data-theme="dark"]` overrides for the
 *       core surface/text tokens and its own 3-level elevation ramp, and
 *       the dark --color-bg override does NOT derive from --brand-neutral
 *       (the brand-neutral-only-themes-light-surfaces guard).
 *     - web/src/components/ThemeToggle.svelte is keyboard/a11y sound
 *       (real <button>, aria-pressed, aria-label) and contains no raw hex.
 *     - web/src/components/Sidebar.svelte mounts <ThemeToggle />.
 *     - web/src/main.ts eager-imports the theme store (DevPanel visibility).
 *
 * This file intentionally does NOT cover motion.css or the general-purpose
 * "no raw hex anywhere in web/src" guardrail lint — separate S1 work items.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { nextTheme, resolveInitialTheme, THEME_STORAGE_KEY } from "../../web/src/lib/theme.ts";

function deno(name: string, fn: () => void | Promise<void>) {
  Deno.test({ name, sanitizeResources: false, sanitizeOps: false, fn });
}

async function read(path: string): Promise<string> {
  return await Deno.readTextFile(path);
}

// ── theme.ts: pure resolution logic ─────────────────────────────────────────

deno("resolveInitialTheme: defaults to light for null/undefined", () => {
  assertEquals(resolveInitialTheme(null), "light");
  assertEquals(resolveInitialTheme(undefined), "light");
});

deno("resolveInitialTheme: defaults to light for any non-'dark' value (garbage, legacy, typo)", () => {
  for (const garbage of ["", "system", "auto", "Dark", "DARK", "light ", " dark", "true", "1"]) {
    assertEquals(resolveInitialTheme(garbage), "light", `expected "light" for stored value ${JSON.stringify(garbage)}`);
  }
});

deno("resolveInitialTheme: resolves to dark ONLY for the exact literal 'dark'", () => {
  assertEquals(resolveInitialTheme("dark"), "dark");
});

deno("resolveInitialTheme: resolves to light for the literal 'light'", () => {
  assertEquals(resolveInitialTheme("light"), "light");
});

deno("nextTheme: toggles between the only two states", () => {
  assertEquals(nextTheme("light"), "dark");
  assertEquals(nextTheme("dark"), "light");
});

deno("THEME_STORAGE_KEY is a stable, non-empty string (shared with index.html's inline script)", () => {
  assert(typeof THEME_STORAGE_KEY === "string" && THEME_STORAGE_KEY.length > 0);
});

// ── theme.svelte.ts: reactive wiring source-shape lints ─────────────────────

deno("theme store: registers via defineStore (DevPanel-visible)", async () => {
  const src = await read("web/src/stores/theme.svelte.ts");
  assertStringIncludes(src, 'defineStore<ThemeState>("theme"');
});

deno("theme store: never calls matchMedia (no OS-auto theming)", async () => {
  const src = await read("web/src/stores/theme.svelte.ts");
  // Doc comments are allowed to explain the guard by name; the code itself
  // must never actually invoke matchMedia() to infer the theme.
  assert(!src.includes("matchMedia("), "theme store must not call matchMedia() (no OS-auto theming)");
});

deno("theme store: persists via localStorage under the shared THEME_STORAGE_KEY", async () => {
  const src = await read("web/src/stores/theme.svelte.ts");
  assertStringIncludes(src, "localStorage.setItem(THEME_STORAGE_KEY");
  assertStringIncludes(src, "localStorage.getItem(THEME_STORAGE_KEY");
});

deno("theme store: applies the resolved theme via a data-theme DOM attribute", async () => {
  const src = await read("web/src/stores/theme.svelte.ts");
  assertStringIncludes(src, 'setAttribute("data-theme"');
});

// ── index.html: anti-FOUC inline script ─────────────────────────────────────

deno("index.html: applies a persisted dark choice before first paint, without OS-auto", async () => {
  const html = await read("web/index.html");
  assertStringIncludes(html, '"alchemist-theme"');
  assertStringIncludes(html, 'setAttribute("data-theme", "dark")');
  // The doc comment above the inline script is allowed to name the media
  // feature to explain the guard; the script itself must never call
  // matchMedia() to infer the theme.
  const scriptBlock = html.split('<script>\n      (function')[1]?.split("</script>")[0] ?? "";
  assert(!scriptBlock.includes("matchMedia"), "index.html's inline theme script must not call matchMedia()");
  // The inline theme script must appear before the module bootstrap script
  // (first paint should already reflect the persisted theme by the time
  // main.ts's store re-applies it).
  const themeScriptIdx = html.indexOf('"alchemist-theme"');
  const mainModuleIdx = html.indexOf('src="/src/main.ts"');
  assert(themeScriptIdx > -1 && mainModuleIdx > -1 && themeScriptIdx < mainModuleIdx);
});

// ── app.css: [data-theme="dark"] token overrides ────────────────────────────

deno('app.css: defines a [data-theme="dark"] override block for the core surface/text tokens', async () => {
  const css = await read("web/src/app.css");
  assertStringIncludes(css, ':root[data-theme="dark"]');
  const darkBlock = css.split(':root[data-theme="dark"]')[1]?.split(/\n}\n/)[0] ?? "";
  for (const token of ["--color-bg", "--color-surface", "--color-surface-raised", "--color-text", "--color-border"]) {
    assert(darkBlock.includes(`${token}:`), `[data-theme="dark"] block must override ${token}`);
  }
});

deno('app.css: dark --color-bg does NOT derive from --brand-neutral (brand-neutral only themes light surfaces)', async () => {
  const css = await read("web/src/app.css");
  const darkBlock = css.split(':root[data-theme="dark"]')[1]?.split(/\n}\n/)[0] ?? "";
  const bgLine = darkBlock.split("\n").find((l) => l.trim().startsWith("--color-bg:"));
  assert(bgLine !== undefined, "dark block must set --color-bg");
  assert(!bgLine!.includes("--brand-neutral"), "dark --color-bg must not reference --brand-neutral");
});

deno("app.css: dark theme redefines its own 3-level elevation ramp (adjusted shadows)", async () => {
  const css = await read("web/src/app.css");
  const darkBlock = css.split(':root[data-theme="dark"]')[1]?.split(/\n}\n/)[0] ?? "";
  for (const level of ["--shadow-sm", "--shadow-md", "--shadow-lg"]) {
    assert(darkBlock.includes(`${level}:`), `[data-theme="dark"] block must override ${level}`);
  }
  // Every elevation token in the whole file (light default + dark override)
  // must still be exactly {sm, md, lg} — no new level introduced.
  const shadowTokenNames = new Set([...css.matchAll(/--shadow-([a-z]+):/g)].map((m) => m[1]));
  assertEquals(shadowTokenNames, new Set(["sm", "md", "lg"]));
});

// ── ThemeToggle.svelte + Sidebar mount ───────────────────────────────────────

const HEX_LITERAL = /#[0-9a-fA-F]{3,8}\b/;

function styleBlocks(svelteSrc: string): string {
  const matches = [...svelteSrc.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)];
  return matches.map((m) => m[1]).join("\n");
}

deno("ThemeToggle: real <button>, keyboard/a11y sound, no raw hex", async () => {
  const src = await read("web/src/components/ThemeToggle.svelte");
  assertStringIncludes(src, "<button");
  assertStringIncludes(src, "aria-pressed=");
  assertStringIncludes(src, "aria-label=");
  assertStringIncludes(src, "themeStore.toggle()");
  assert(!HEX_LITERAL.test(styleBlocks(src)), "ThemeToggle.svelte: <style> block should not contain a raw hex literal");
});

deno("ThemeToggle: hover/active transition only touches compositor-safe properties", async () => {
  const src = await read("web/src/components/ThemeToggle.svelte");
  const style = styleBlocks(src);
  const transitionLines = style.match(/transition:[^;]+;/g) ?? [];
  assert(transitionLines.length > 0, "expected at least one transition declaration");
  for (const line of transitionLines) {
    assert(!/\btransition:\s*all\b/.test(line), `must not use "transition: all": ${line}`);
    assert(!/background(-color)?\s*[0-9.]/.test(line), `must not transition background: ${line}`);
    assert(!/box-shadow\s*[0-9.]/.test(line), `must not transition box-shadow: ${line}`);
  }
});

deno("Sidebar.svelte mounts <ThemeToggle />", async () => {
  const src = await read("web/src/components/Sidebar.svelte");
  assertStringIncludes(src, "<ThemeToggle />");
  assertStringIncludes(src, 'from "./ThemeToggle.svelte"');
});

deno("main.ts eager-imports the theme store", async () => {
  const src = await read("web/src/main.ts");
  assertStringIncludes(src, './stores/theme.svelte"');
});
