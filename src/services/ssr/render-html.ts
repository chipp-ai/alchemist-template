/**
 * HTML helpers for server-rendered (SSR) pages. Part of the SSR kernel:
 * see `.claude/rules/ssr.md`.
 *
 * THIS MODULE IS A SECURITY BOUNDARY. Public pages render text that came
 * from config, the database or a seller. The rules:
 *
 * - Every interpolated string goes through `escapeHtml`.
 * - Every `href` built from data goes through `sanitizeHref`. A null result
 *   renders as plain text, never as a link.
 * - Markdown becomes HTML only through `renderMarkdownToHtml`. It escapes
 *   first, so raw HTML in the source always renders as text.
 *
 * `escapeHtml` and `sanitizeHref` are the base copies from
 * `src/lib/safe-html.ts`, re-exported so SSR code has one import.
 */

import { escapeHtml, sanitizeHref } from "@/lib/safe-html.ts";

export { escapeHtml, sanitizeHref };

export interface MarkdownOptions {
  /**
   * When set, a same-site link (`/x`) becomes an anchor only when its path
   * is one of these prefixes or sits under one (`/products` allows
   * `/products` and `/products/a`, not `/productsx`). Absolute http(s),
   * mailto: and `#fragment` links are unaffected. Unset: any same-site
   * path `sanitizeHref` accepts.
   */
  allowedPathPrefixes?: readonly string[];
}

/** Undo `escapeHtml` for a captured href, so it can be checked as written. */
function unescapeHtml(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function pathAllowed(href: string, prefixes: readonly string[] | undefined): boolean {
  if (!prefixes || !href.startsWith("/")) return true;
  const path = href.split(/[?#]/, 1)[0];
  return prefixes.some((p) => path === p || path.startsWith(p.endsWith("/") ? p : `${p}/`));
}

/**
 * The href to emit for a markdown link, or null when the link must stay
 * plain text. tel: links are not allowed in markdown.
 */
function markdownHref(raw: string, opts: MarkdownOptions): string | null {
  const safe = sanitizeHref(raw);
  if (safe === null || /^tel:/i.test(safe)) return null;
  return pathAllowed(safe, opts.allowedPathPrefixes) ? safe : null;
}

/**
 * Inline transforms on one block of text. Escapes first, then: inline code
 * (protected from later passes), links (allowlisted), **bold**, *italic*.
 */
function renderInline(raw: string, opts: MarkdownOptions): string {
  let s = escapeHtml(raw);

  const codeSpans: string[] = [];
  s = s.replace(/`([^`]+)`/g, (_m, code: string) => {
    codeSpans.push(`<code>${code}</code>`);
    return `\u0000${codeSpans.length - 1}\u0000`;
  });

  s = s.replace(/\[([^\]]+)\]\(([^()\s]+)\)/g, (match, text: string, href: string) => {
    const safe = markdownHref(unescapeHtml(href), opts);
    if (safe === null) return match;
    const rel = /^https?:/i.test(safe) ? ` rel="noopener noreferrer"` : "";
    return `<a href="${escapeHtml(safe)}"${rel}>${text}</a>`;
  });

  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/\*([^*]+)\*/g, "<em>$1</em>");

  s = s.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => codeSpans[Number(i)] ?? "");
  return s;
}

const LIST_ITEM_RE = /^(\s*)([-*]|\d+\.)\s+(.*)$/;
const HR_RE = /^\s*(-{3,}|\*{3,}|_{3,})\s*$/;
const QUOTE_RE = /^\s*>\s?/;

function isTableSeparator(line: string): boolean {
  const t = line.trim();
  return /^\|?[\s:|-]+\|?$/.test(t) && t.includes("-") && t.includes("|");
}

function splitTableRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s.split("|").map((c) => c.trim());
}

interface ListNode {
  ordered: boolean;
  items: { text: string; child: ListNode | null }[];
}

function renderList(list: ListNode, opts: MarkdownOptions): string {
  const tag = list.ordered ? "ol" : "ul";
  const items = list.items
    .map((it) => `<li>${renderInline(it.text, opts)}${it.child ? renderList(it.child, opts) : ""}</li>`)
    .join("");
  return `<${tag}>${items}</${tag}>`;
}

function startsBlock(lines: string[], i: number): boolean {
  const l = lines[i];
  return l.trim() === "" || /^```/.test(l) || /^#{1,6}\s/.test(l) || HR_RE.test(l) ||
    QUOTE_RE.test(l) || LIST_ITEM_RE.test(l) ||
    (l.includes("|") && i + 1 < lines.length && isTableSeparator(lines[i + 1]));
}

/**
 * Render a strict markdown subset to safe HTML: headings, fenced code,
 * inline code, **bold**, *italic*, lists (one nesting level), links,
 * paragraphs, rules, blockquotes and simple pipe tables. No raw HTML, ever.
 */
export function renderMarkdownToHtml(md: string, opts: MarkdownOptions = {}): string {
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.trim() === "") {
      i++;
      continue;
    }

    const fence = line.match(/^```([A-Za-z0-9_-]*)\s*$/);
    if (fence) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) buf.push(lines[i++]);
      i++;
      const cls = fence[1] ? ` class="language-${fence[1]}"` : "";
      out.push(`<pre><code${cls}>${escapeHtml(buf.join("\n"))}</code></pre>`);
      continue;
    }

    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      out.push(`<h${h[1].length}>${renderInline(h[2], opts)}</h${h[1].length}>`);
      i++;
      continue;
    }

    if (HR_RE.test(line)) {
      out.push("<hr>");
      i++;
      continue;
    }

    if (line.includes("|") && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      const headers = splitTableRow(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].includes("|") && lines[i].trim() !== "") {
        rows.push(splitTableRow(lines[i++]));
      }
      const thead = `<thead><tr>${headers.map((c) => `<th>${renderInline(c, opts)}</th>`).join("")}</tr></thead>`;
      const tbody = rows.length
        ? `<tbody>${
          rows.map((r) => `<tr>${r.map((c) => `<td>${renderInline(c, opts)}</td>`).join("")}</tr>`).join("")
        }</tbody>`
        : "";
      out.push(`<table>${thead}${tbody}</table>`);
      continue;
    }

    if (QUOTE_RE.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && QUOTE_RE.test(lines[i])) buf.push(lines[i++].replace(QUOTE_RE, ""));
      out.push(`<blockquote><p>${renderInline(buf.join(" "), opts)}</p></blockquote>`);
      continue;
    }

    const first = line.match(LIST_ITEM_RE);
    if (first) {
      const root: ListNode = { ordered: /^\d+\.$/.test(first[2]), items: [] };
      while (i < lines.length && lines[i].trim() !== "") {
        const l = lines[i];
        const m = l.match(LIST_ITEM_RE);
        if (m) {
          const item = { text: m[3], child: null };
          if (m[1].length >= 2 && root.items.length > 0) {
            const parent = root.items[root.items.length - 1];
            parent.child ??= { ordered: /^\d+\.$/.test(m[2]), items: [] };
            parent.child.items.push(item);
          } else {
            root.items.push(item);
          }
          i++;
          continue;
        }
        if (/^\s{2,}\S/.test(l) && root.items.length > 0) {
          const parent = root.items[root.items.length - 1];
          const target = parent.child ? parent.child.items[parent.child.items.length - 1] : parent;
          target.text += ` ${l.trim()}`;
          i++;
          continue;
        }
        break;
      }
      out.push(renderList(root, opts));
      continue;
    }

    const buf: string[] = [line.trim()];
    i++;
    while (i < lines.length && !startsBlock(lines, i)) buf.push(lines[i++].trim());
    out.push(`<p>${renderInline(buf.join(" "), opts)}</p>`);
  }

  return out.join("\n");
}
