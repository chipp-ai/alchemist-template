#!/usr/bin/env node
// AEO check for the built landing site. Runs after `astro build` (npm run build)
// and in CI. It fails the build when a page breaks one of the rules in
// landing/README.md, so answer engines and assistive tech can always read
// the site:
//
//   - one H1, with a plain definition (60 words or less) right under it
//   - at least one H2 or H3 question, each answered in 100 words or less
//   - header, nav, main and footer landmarks are present
//   - icon-only buttons and links have an aria-label
//   - every img has alt text
//   - every form field has a label
//   - no div or span acts as a button (onclick or role="button")
//   - every internal link resolves to a built file
//   - visible Published and Updated dates, plus the same dates in JSON-LD
//   - key facts say "as of <Month Year>"
//   - FAQPage JSON-LD text matches the visible text word for word
//   - robots.txt lets AI search crawlers in, meta-webindexer included
//   - sitemap entries carry a lastmod
//
// No dependencies: it reads the HTML with small regexes. It is a guard for
// the pages this template builds, not a general HTML validator.
//
// Usage: npm run build   (or: node scripts/aeo-check.mjs [distDir])

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Paths the Deno app serves, not the landing build: never "broken" here. */
const APP_SERVED_PREFIXES = ["/app/", "/api/"];
const APP_SERVED_EXACT = new Set(["/app"]);

/** Crawlers robots.txt must allow. */
const REQUIRED_CRAWLERS = ["meta-webindexer", "GPTBot", "OAI-SearchBot", "ClaudeBot", "PerplexityBot"];

const MAX_ANSWER_WORDS = 100;
const MAX_DEFINITION_WORDS = 60;

// ── HTML helpers ──

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

export function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** Text a reader sees: tags removed, entities decoded, whitespace collapsed. */
export function textOf(html) {
  return decodeEntities(
    html
      .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " "),
  ).replace(/\s+/g, " ").trim();
}

/** Attributes of one start tag, lower-cased names. */
export function attrsOf(tag) {
  const out = {};
  const body = tag.replace(/^<\s*[a-zA-Z0-9-]+/, "").replace(/\/?>$/, "");
  const re = /([^\s"'=<>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  let m;
  while ((m = re.exec(body))) {
    out[m[1].toLowerCase()] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? "");
  }
  return out;
}

function bodyOf(html) {
  const m = html.match(/<body\b[^>]*>([\s\S]*)<\/body>/i);
  return m ? m[1] : html;
}

function wordCount(text) {
  return text.split(/\s+/).filter(Boolean).length;
}

function hasName(a) {
  return Boolean((a["aria-label"] ?? "").trim() || (a["aria-labelledby"] ?? "").trim() || (a.title ?? "").trim());
}

/** JSON-LD nodes on the page, flattened out of @graph. */
export function jsonLdNodes(html, errors) {
  const nodes = [];
  const re = /<script\b[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    try {
      const data = JSON.parse(m[1]);
      const list = Array.isArray(data) ? data : [data];
      for (const item of list) {
        if (item && Array.isArray(item["@graph"])) nodes.push(...item["@graph"]);
        else if (item) nodes.push(item);
      }
    } catch (err) {
      errors.push(`JSON-LD does not parse: ${err.message}`);
    }
  }
  return nodes;
}

function isValidDate(s) {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}/.test(s) && !Number.isNaN(Date.parse(s));
}

// ── Page check ──

/**
 * Check one built page. `resolves(path)` answers whether a site-absolute
 * path exists in the build. Returns a list of problems (empty = pass).
 */
export function checkPage(html, { resolves = () => true } = {}) {
  const errors = [];
  const body = bodyOf(html);

  // Headings: one H1 with a plain definition right under it, H2s after it,
  // and at least one question heading (H2 or H3) with a short answer.
  const h1s = [...body.matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi)];
  if (h1s.length !== 1) errors.push(`expected exactly one <h1>, found ${h1s.length}`);
  const h1 = h1s[0];
  const h1Index = h1?.index ?? -1;
  if (h1) {
    const afterH1 = body.slice(h1.index + h1[0].length);
    const definition = /<p\b[^>]*>([\s\S]*?)<\/p>/i.exec(afterH1);
    const nextHeading = /<h[2-6]\b/i.exec(afterH1);
    if (!definition || (nextHeading && nextHeading.index < definition.index)) {
      errors.push("no paragraph under the <h1>: say what the product is in plain words right under it");
    } else if (wordCount(textOf(definition[1])) > MAX_DEFINITION_WORDS) {
      errors.push(
        `the paragraph under the <h1> is ${wordCount(textOf(definition[1]))} words; keep it to ${MAX_DEFINITION_WORDS} or less`,
      );
    }
  }
  const firstH2 = /<h2\b[^>]*>/i.exec(body);
  if (firstH2 && (h1Index < 0 || firstH2.index < h1Index)) errors.push("the first <h2> comes before the <h1>");
  const questions = [...body.matchAll(/<(h[23])\b[^>]*>([\s\S]*?)<\/\1>/gi)]
    .filter((m) => textOf(m[2]).endsWith("?"));
  if (questions.length === 0) {
    errors.push("no question heading: answer the reader's main question in an H2 or H3 that ends in \"?\"");
  }
  for (const q of questions) {
    // The answer: the first paragraph after the question.
    const after = body.slice(q.index + q[0].length);
    const answer = /<p\b[^>]*>([\s\S]*?)<\/p>/i.exec(after);
    const question = textOf(q[2]);
    if (!answer) {
      errors.push(`no answer paragraph under the question "${question}"`);
      continue;
    }
    const words = wordCount(textOf(answer[1]));
    if (words > MAX_ANSWER_WORDS) {
      errors.push(`the answer to "${question}" is ${words} words; keep it to ${MAX_ANSWER_WORDS} or less`);
    }
  }

  // Landmarks (semantic HTML).
  for (const tag of ["header", "nav", "main", "footer"]) {
    if (!new RegExp(`<${tag}\\b`, "i").test(body)) errors.push(`missing <${tag}> landmark`);
  }
  if ((body.match(/<main\b/gi) ?? []).length > 1) errors.push("more than one <main>");

  // Key product info must be in the HTML, not drawn by JS.
  if (wordCount(textOf(body)) < 40) errors.push("the page has almost no text in its HTML");

  // Buttons and links need an accessible name.
  for (const m of body.matchAll(/(<(button|a)\b[^>]*>)([\s\S]*?)<\/\2>/gi)) {
    const a = attrsOf(m[1]);
    const inner = m[3];
    const imgAlts = [...inner.matchAll(/<img\b[^>]*>/gi)].map((i) => (attrsOf(i[0]).alt ?? "").trim()).join("");
    if (!textOf(inner) && !imgAlts && !hasName(a)) {
      errors.push(`<${m[2].toLowerCase()}> with no text needs an aria-label: ${m[1].slice(0, 80)}`);
    }
  }

  // Images need alt text. alt="" is only for decoration marked as such.
  for (const m of body.matchAll(/<img\b[^>]*>/gi)) {
    const a = attrsOf(m[0]);
    if (!("alt" in a)) errors.push(`<img> without alt: ${m[0].slice(0, 80)}`);
    else if (!a.alt.trim() && a.role !== "presentation" && a["aria-hidden"] !== "true") {
      errors.push(`<img> with empty alt must be marked decorative (aria-hidden="true"): ${m[0].slice(0, 80)}`);
    }
  }

  // Form fields need a label.
  const labelFor = new Set([...body.matchAll(/<label\b[^>]*>/gi)].map((m) => attrsOf(m[0]).for).filter(Boolean));
  const opens = [...body.matchAll(/<label\b/gi)].map((m) => m.index);
  const closes = [...body.matchAll(/<\/label>/gi)].map((m) => m.index);
  const insideLabel = (pos) => {
    const lastOpen = Math.max(-1, ...opens.filter((i) => i < pos));
    const lastClose = Math.max(-1, ...closes.filter((i) => i < pos));
    return lastOpen > lastClose;
  };
  for (const m of body.matchAll(/<(input|select|textarea)\b[^>]*>/gi)) {
    const a = attrsOf(m[0]);
    const type = (a.type ?? "text").toLowerCase();
    if (m[1].toLowerCase() === "input" && ["hidden", "submit", "button", "reset", "image"].includes(type)) continue;
    if (hasName(a) || (a.id && labelFor.has(a.id)) || insideLabel(m.index)) continue;
    errors.push(`<${m[1].toLowerCase()}> without a <label>: ${m[0].slice(0, 80)}`);
  }

  // Use <button> for actions, never a clickable div or span.
  for (const m of body.matchAll(/<(div|span)\b[^>]*>/gi)) {
    const a = attrsOf(m[0]);
    if ("onclick" in a || a.role === "button") {
      errors.push(`<${m[1].toLowerCase()}> used as a button; use <button>: ${m[0].slice(0, 80)}`);
    }
  }

  // Internal links resolve.
  const linkHtml = html.replace(/<script\b[\s\S]*?<\/script>/gi, "");
  for (const m of linkHtml.matchAll(/(?:href|src)\s*=\s*"([^"]+)"/gi)) {
    let url = decodeEntities(m[1]);
    if (!url.startsWith("/") || url.startsWith("//")) continue;
    url = url.split("#")[0].split("?")[0];
    if (!url) continue;
    if (APP_SERVED_EXACT.has(url) || APP_SERVED_PREFIXES.some((p) => url.startsWith(p))) continue;
    if (!resolves(url)) errors.push(`broken internal link: ${url}`);
  }

  // Visible dates.
  const published = /Published\s*<time\b[^>]*\bdatetime\s*=\s*"([^"]+)"/i.exec(body);
  const updated = /Updated\s*<time\b[^>]*\bdatetime\s*=\s*"([^"]+)"/i.exec(body);
  if (!published || !isValidDate(published[1])) errors.push('missing a visible "Published <time datetime>" date');
  if (!updated || !isValidDate(updated[1])) errors.push('missing a visible "Updated <time datetime>" date');

  // "as of <Month Year>" on key facts.
  if (!/\bas of [A-Z][a-z]+ \d{4}\b/.test(textOf(body))) errors.push('no "as of <Month Year>" on the page\'s key facts');

  // JSON-LD: present, dated, and FAQ text equal to what the reader sees.
  const nodes = jsonLdNodes(html, errors);
  if (nodes.length === 0) errors.push("no JSON-LD on the page");
  const dated = nodes.find((n) => n.datePublished || n.dateModified);
  if (!dated || !isValidDate(dated.datePublished) || !isValidDate(dated.dateModified)) {
    errors.push("JSON-LD has no datePublished and dateModified");
  } else {
    if (published && dated.datePublished !== published[1]) {
      errors.push(`JSON-LD datePublished ${dated.datePublished} differs from the visible ${published[1]}`);
    }
    if (updated && dated.dateModified !== updated[1]) {
      errors.push(`JSON-LD dateModified ${dated.dateModified} differs from the visible ${updated[1]}`);
    }
  }
  const visible = textOf(body);
  for (const faq of nodes.filter((n) => n["@type"] === "FAQPage")) {
    for (const q of faq.mainEntity ?? []) {
      const name = String(q.name ?? "").replace(/\s+/g, " ").trim();
      const text = String(q.acceptedAnswer?.text ?? "").replace(/\s+/g, " ").trim();
      if (!name || !visible.includes(name)) errors.push(`FAQ JSON-LD question is not on the page: "${name}"`);
      if (!text || !visible.includes(text)) errors.push(`FAQ JSON-LD answer is not on the page: "${text.slice(0, 60)}"`);
    }
  }

  return errors;
}

/** robots.txt must let AI search crawlers in. */
export function checkRobots(text) {
  const errors = [];
  const groups = text.split(/\n\s*\n/);
  for (const agent of REQUIRED_CRAWLERS) {
    const group = groups.find((g) => new RegExp(`^User-agent:\\s*${agent}\\s*$`, "im").test(g));
    if (!group) {
      errors.push(`robots.txt has no rule for ${agent}`);
      continue;
    }
    if (/^Disallow:\s*\/\s*$/im.test(group) || !/^Allow:\s*\/\s*$/im.test(group)) {
      errors.push(`robots.txt must allow ${agent}`);
    }
  }
  return errors;
}

/** Every sitemap entry carries a lastmod. */
export function checkSitemap(xml) {
  const errors = [];
  for (const m of xml.matchAll(/<url>([\s\S]*?)<\/url>/g)) {
    if (!/<loc>https?:\/\/[^<]+<\/loc>/.test(m[1])) errors.push("sitemap <url> without an absolute <loc>");
    if (!/<lastmod>\d{4}-\d{2}-\d{2}/.test(m[1])) errors.push("sitemap <url> without a <lastmod>");
  }
  return errors;
}

// ── Runner ──

function collectHtml(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...collectHtml(full));
    else if (entry.endsWith(".html")) out.push(full);
  }
  return out;
}

export function makeResolver(dist) {
  return (urlPath) => {
    const p = urlPath === "/" ? "" : urlPath.replace(/\/$/, "");
    const direct = join(dist, p);
    if (existsSync(direct) && statSync(direct).isFile()) return true;
    if (existsSync(join(dist, p, "index.html"))) return true;
    return existsSync(`${direct}.html`);
  };
}

/** Check a whole build. Returns problems as "file: message" strings. */
export function checkDist(dist) {
  const problems = [];
  const resolves = makeResolver(dist);
  const pages = collectHtml(dist);
  if (pages.length === 0) problems.push("no HTML pages in the build");
  for (const file of pages) {
    for (const e of checkPage(readFileSync(file, "utf8"), { resolves })) {
      problems.push(`${relative(dist, file)}: ${e}`);
    }
  }
  const robots = join(dist, "robots.txt");
  if (!existsSync(robots)) problems.push("robots.txt is missing");
  else problems.push(...checkRobots(readFileSync(robots, "utf8")).map((e) => `robots.txt: ${e}`));
  const sitemap = join(dist, "sitemap.xml");
  if (!existsSync(sitemap)) problems.push("sitemap.xml is missing");
  else problems.push(...checkSitemap(readFileSync(sitemap, "utf8")).map((e) => `sitemap.xml: ${e}`));
  return { pages: pages.length, problems };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const here = dirname(fileURLToPath(import.meta.url));
  const dist = process.argv[2] ?? join(here, "..", "dist");
  if (!existsSync(dist)) {
    console.error(`[aeo-check] ${dist} not found. Run "astro build" first.`);
    process.exit(2);
  }
  const { pages, problems } = checkDist(dist);
  if (problems.length > 0) {
    console.error(`[aeo-check] ${problems.length} problem(s) in ${pages} page(s):`);
    for (const p of problems) console.error(`  - ${p}`);
    console.error("[aeo-check] The rules are in landing/README.md.");
    process.exit(1);
  }
  console.log(`[aeo-check] OK: ${pages} page(s) pass the AEO rules.`);
}
