/**
 * SSR kernel (src/services/ssr/*, src/lib/spa-shell.ts, src/config/site.ts,
 * src/services/app-links.ts). DB-free.
 */

import { assert, assertEquals, assertFalse, assertStringIncludes } from "@std/assert";
import { Hono } from "hono";
import {
  escapeHtml,
  renderMarkdownToHtml,
  sanitizeHref,
} from "@/services/ssr/render-html.ts";
import { safeJsonAttr, safeJsonScript } from "@/services/ssr/safe-json.ts";
import {
  __setIslandsManifestPathForTests,
  ISLANDS_ENTRY_SRC,
  prodIslandsScriptTag,
  renderIsland,
  resolveIslandsTagFromManifestJson,
} from "@/services/ssr/islands.ts";
import { currentDesign, designHead, designHtmlAttributes } from "@/services/ssr/design-head.ts";
import { __setSpaIndexPathForTests, renderSpaShellHtml, serveSpaShell } from "@/lib/spa-shell.ts";
import { appPath } from "@/config/site.ts";
import { appOrigin, originFrom } from "@/services/app-links.ts";
import { escapeHtml as baseEscapeHtml, sanitizeHref as baseSanitizeHref } from "@/lib/safe-html.ts";
import { getEnv } from "@/lib/env.ts";

const SPA_FIXTURE = new URL("../fixtures/spa-shell-index.html", import.meta.url);

// ── render-html ──

Deno.test("render-html re-exports the one base escapeHtml and sanitizeHref", () => {
  assertEquals(escapeHtml, baseEscapeHtml);
  assertEquals(sanitizeHref, baseSanitizeHref);
});

Deno.test("renderMarkdownToHtml: raw HTML is text, never markup", () => {
  const html = renderMarkdownToHtml(`<script>alert(1)</script>\n\n**bold** <img src=x onerror=y>`);
  assertFalse(html.includes("<script>"));
  assertFalse(html.includes("<img"));
  assertStringIncludes(html, "&lt;script&gt;alert(1)&lt;/script&gt;");
  assertStringIncludes(html, "<strong>bold</strong>");
});

Deno.test("renderMarkdownToHtml: links follow the allowlist", () => {
  const html = renderMarkdownToHtml(
    "[a](javascript:alert(1)) [b](//evil.example) [c](/ok) [d](https://x.example/p?a=1&b=2) " +
      "[e](data:text/html,x) [f](/images/../admin) [g](tel:+1555)",
  );
  assertFalse(html.includes('href="javascript:'));
  assertFalse(html.includes('href="//evil'));
  assertFalse(html.includes('href="data:'));
  assertFalse(html.includes('href="/images/../admin"'));
  assertFalse(html.includes('href="tel:'));
  assertStringIncludes(html, '<a href="/ok">c</a>');
  assertStringIncludes(
    html,
    '<a href="https://x.example/p?a=1&amp;b=2" rel="noopener noreferrer">d</a>',
  );
});

Deno.test("renderMarkdownToHtml: allowedPathPrefixes limits same-site links", () => {
  const html = renderMarkdownToHtml("[a](/admin) [b](/products/x) [c](/products) [d](/productsx)", {
    allowedPathPrefixes: ["/products"],
  });
  assertFalse(html.includes('href="/admin"'));
  assertFalse(html.includes('href="/productsx"'));
  assertStringIncludes(html, '<a href="/products/x">b</a>');
  assertStringIncludes(html, '<a href="/products">c</a>');
});

Deno.test("renderMarkdownToHtml: block subset", () => {
  const html = renderMarkdownToHtml(
    "# Title\n\n- one\n- two\n  - nested\n\n1. first\n\n> quote\n\n```\n<b>code</b>\n```\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n---",
  );
  assertStringIncludes(html, "<h1>Title</h1>");
  assertStringIncludes(html, "<ul><li>one</li><li>two<ul><li>nested</li></ul></li></ul>");
  assertStringIncludes(html, "<ol><li>first</li></ol>");
  assertStringIncludes(html, "<blockquote><p>quote</p></blockquote>");
  assertStringIncludes(html, "<pre><code>&lt;b&gt;code&lt;/b&gt;</code></pre>");
  assertStringIncludes(html, "<table><thead><tr><th>a</th><th>b</th></tr></thead>");
  assertStringIncludes(html, "<hr>");
});

// ── safe-json ──

Deno.test("safeJsonScript: a </script> in a value cannot end the block, and it round-trips", () => {
  const value = { name: "</script><script>x()</script>", sep: "a\u2028b", amp: "a&b" };
  const out = safeJsonScript(value);
  assertFalse(out.includes("</"));
  assertFalse(out.includes("\u2028"));
  assertEquals(JSON.parse(out), value);
});

Deno.test("safeJsonAttr: no raw quote can end the attribute", () => {
  const out = safeJsonAttr({ q: `"'`, t: "<x>" });
  assertFalse(out.includes('"'));
  assertFalse(out.includes("'"));
  assertFalse(out.includes("<"));
});

// ── islands ──

Deno.test("renderIsland: escapes the name and serializes props into the marker", () => {
  const html = renderIsland(`Cart"Badge`, { label: `"</div>` }, "<span>0</span>");
  assert(html.startsWith('<div data-island="Cart&quot;Badge" data-props="'));
  assert(html.endsWith("><span>0</span></div>"));
  assertFalse(html.includes(`"</div>"`));
});

Deno.test("resolveIslandsTagFromManifestJson: script + css from the entry chunk; null otherwise", () => {
  const manifest = JSON.stringify({
    [ISLANDS_ENTRY_SRC]: { file: "assets/islands-abc.js", css: ["assets/islands-abc.css"] },
  });
  assertEquals(
    resolveIslandsTagFromManifestJson(manifest),
    '<link rel="stylesheet" href="/assets/islands-abc.css" />\n' +
      '<script type="module" src="/assets/islands-abc.js"></script>',
  );
  assertEquals(resolveIslandsTagFromManifestJson("not json"), null);
  assertEquals(resolveIslandsTagFromManifestJson("{}"), null);
  assertEquals(resolveIslandsTagFromManifestJson(JSON.stringify({ [ISLANDS_ENTRY_SRC]: {} })), null);
});

Deno.test("the production islands tag reads the built manifest, and is empty (not a throw) without one", async () => {
  // Never flip ALCHEMIST_DEV_ROUTES here: parallel test files share one
  // process environment, and other files (the dev mailbox) read that flag.
  const dir = await Deno.makeTempDir();
  try {
    const path = `${dir}/manifest.json`;
    await Deno.writeTextFile(path, JSON.stringify({ [ISLANDS_ENTRY_SRC]: { file: "assets/i.js" } }));
    __setIslandsManifestPathForTests(path);
    assertEquals(prodIslandsScriptTag(), '<script type="module" src="/assets/i.js"></script>');
    __setIslandsManifestPathForTests(`${dir}/missing.json`);
    assertEquals(prodIslandsScriptTag(), "");
  } finally {
    __setIslandsManifestPathForTests(null);
    await Deno.remove(dir, { recursive: true });
  }
});

// ── design-head ──

Deno.test("designHead carries the project's design tokens and fonts", () => {
  const head = designHead();
  assertStringIncludes(head, '<style id="design-tokens">:root {');
  for (const token of ["--color-bg", "--color-text", "--brand-primary", "--space-md", "--text-base", "--radius-md", "--font-sans"]) {
    assertStringIncludes(head, `${token}:`);
  }
  assertStringIncludes(head, "https://fonts.googleapis.com/css2?");
});

Deno.test("designHtmlAttributes has a leading space and the design's mode", () => {
  const attrs = designHtmlAttributes();
  assert(attrs.startsWith(" data-radius-scale="));
  assertStringIncludes(attrs, `data-design-mode="${currentDesign().mode}"`);
});

// ── spa-shell ──

Deno.test("serveSpaShell serves the built shell, and 404s when it is not built", async () => {
  const app = new Hono();
  app.get("/admin", serveSpaShell);
  try {
    __setSpaIndexPathForTests(SPA_FIXTURE);
    const res = await app.request("/admin");
    assertEquals(res.status, 200);
    assertEquals(await res.text(), await Deno.readTextFile(SPA_FIXTURE));
    __setSpaIndexPathForTests(new URL(`./missing-${crypto.randomUUID()}.html`, import.meta.url));
    assertEquals(renderSpaShellHtml(), null);
    assertEquals((await app.request("/admin")).status, 404);
  } finally {
    __setSpaIndexPathForTests(null);
  }
});

// ── site + app-links ──

Deno.test("appPath links into the SPA at the site root and rejects a relative path", () => {
  assertEquals(appPath("/#/login"), "/#/login");
  let threw = false;
  try {
    appPath("#/login");
  } catch {
    threw = true;
  }
  assert(threw);
});

Deno.test("the origin is APP_URL without a trailing slash, or the dev origin", () => {
  // originFrom is the pure half of appOrigin(); the env is never mutated
  // here, since parallel test files share it.
  assertEquals(originFrom("https://shop.example.com//"), "https://shop.example.com");
  assertEquals(originFrom("  "), "http://localhost:8000");
  assertEquals(originFrom(undefined), "http://localhost:8000");
  assertEquals(appOrigin(), originFrom(getEnv("APP_URL")));
});
