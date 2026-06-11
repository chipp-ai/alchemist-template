/**
 * Markdown chunking for the docs search index.
 *
 * A page is split into sections by its markdown headings (`#`..`######`).
 * Each section carries its heading text + body. Sections longer than
 * MAX_CHUNK_CHARS are sub-split on paragraph boundaries so a search
 * result points at a focused passage, not a whole page. Fenced code
 * blocks are kept intact (we don't split inside a ``` fence).
 *
 * Mirrors the platform agent docs-search chunker so in-app search and
 * agent docs search rank comparably.
 */

export interface DocChunk {
  /** 0-based order within the page. */
  seq: number;
  /** The nearest heading text above this chunk ("" before the first heading). */
  heading: string;
  /** The chunk text (heading line + body), what we embed + match. */
  content: string;
}

/** Sub-split a section longer than this many chars. */
export const MAX_CHUNK_CHARS = 1_800;

const HEADING_RE = /^(#{1,6})\s+(.*\S)\s*$/;
const FENCE_RE = /^```/;

/** Split a paragraph-joined string so each piece is <= MAX_CHUNK_CHARS. */
function splitLong(text: string): string[] {
  if (text.length <= MAX_CHUNK_CHARS) return [text];
  const paras = text.split(/\n{2,}/);
  const out: string[] = [];
  let buf = "";
  for (const p of paras) {
    if (buf && (buf.length + p.length + 2) > MAX_CHUNK_CHARS) {
      out.push(buf);
      buf = "";
    }
    // A single oversized paragraph: hard-slice it.
    if (p.length > MAX_CHUNK_CHARS) {
      if (buf) {
        out.push(buf);
        buf = "";
      }
      for (let i = 0; i < p.length; i += MAX_CHUNK_CHARS) {
        out.push(p.slice(i, i + MAX_CHUNK_CHARS));
      }
      continue;
    }
    buf = buf ? `${buf}\n\n${p}` : p;
  }
  if (buf) out.push(buf);
  return out;
}

/**
 * Chunk a markdown document into heading-scoped sections.
 * `title` seeds the heading for any preamble before the first `#`.
 */
export function chunkMarkdown(body: string, title = ""): DocChunk[] {
  const lines = body.split("\n");
  const sections: { heading: string; lines: string[] }[] = [];
  let current = { heading: title, lines: [] as string[] };
  let inFence = false;

  for (const line of lines) {
    if (FENCE_RE.test(line.trim())) inFence = !inFence;
    const m = !inFence ? line.match(HEADING_RE) : null;
    if (m) {
      if (current.lines.some((l) => l.trim() !== "") || current.heading) {
        sections.push(current);
      }
      current = { heading: m[2], lines: [line] };
    } else {
      current.lines.push(line);
    }
  }
  if (current.lines.some((l) => l.trim() !== "") || current.heading) {
    sections.push(current);
  }

  const chunks: DocChunk[] = [];
  let seq = 0;
  for (const sec of sections) {
    const text = sec.lines.join("\n").trim();
    if (!text) continue;
    for (const piece of splitLong(text)) {
      const trimmed = piece.trim();
      if (!trimmed) continue;
      chunks.push({ seq: seq++, heading: sec.heading, content: trimmed });
    }
  }
  return chunks;
}

/** Stable SHA-256 hex of a chunk's content (skip re-embedding unchanged text). */
export async function contentHash(content: string): Promise<string> {
  const data = new TextEncoder().encode(content);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
