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

/** Split a paragraph-joined string so each piece is <= `max` chars. */
function splitLong(text: string, max: number = MAX_CHUNK_CHARS): string[] {
  if (text.length <= max) return [text];
  const paras = text.split(/\n{2,}/);
  const out: string[] = [];
  let buf = "";
  for (const p of paras) {
    if (buf && (buf.length + p.length + 2) > max) {
      out.push(buf);
      buf = "";
    }
    // A single oversized paragraph: hard-slice it.
    if (p.length > max) {
      if (buf) {
        out.push(buf);
        buf = "";
      }
      for (let i = 0; i < p.length; i += max) {
        out.push(p.slice(i, i + max));
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
    const allText = sec.lines.join("\n").trim();
    if (!allText) continue;

    // The literal heading line (if this section started with one). We keep
    // it on the first chunk AND re-attach the heading to every sub-split
    // tail chunk — otherwise tail chunks embed without their section's
    // topic, which hurts recall on long sections.
    const headingLineIdx = sec.lines.findIndex((l) => /^#{1,6}\s+/.test(l.trim()));
    const headingPrefix = headingLineIdx >= 0
      ? sec.lines[headingLineIdx].trim()
      : (sec.heading ? `# ${sec.heading}` : "");
    const body = headingLineIdx >= 0
      ? sec.lines.slice(headingLineIdx + 1).join("\n").trim()
      : allText;

    // Reserve room for the prefix so prefixed chunks stay within the cap.
    const budget = Math.max(400, MAX_CHUNK_CHARS - headingPrefix.length - 2);
    const pieces = body ? splitLong(body, budget) : [];

    if (pieces.length === 0) {
      // Heading-only section (no body).
      if (headingPrefix) {
        chunks.push({ seq: seq++, heading: sec.heading, content: headingPrefix });
      }
      continue;
    }
    for (const piece of pieces) {
      const ptrim = piece.trim();
      if (!ptrim) continue;
      const content = headingPrefix ? `${headingPrefix}\n\n${ptrim}` : ptrim;
      chunks.push({ seq: seq++, heading: sec.heading, content });
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
