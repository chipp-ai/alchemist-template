/**
 * Docs chunking + hashing — pure logic, no DB.
 */

import { assert, assertEquals } from "@std/assert";
import { chunkMarkdown, contentHash, MAX_CHUNK_CHARS } from "@/services/docs/chunk.ts";

Deno.test("chunk: splits a doc into heading-scoped sections", () => {
  const md = [
    "# Title",
    "Intro paragraph.",
    "",
    "## Section A",
    "Body of A.",
    "",
    "## Section B",
    "Body of B.",
  ].join("\n");

  const chunks = chunkMarkdown(md, "Title");
  const headings = chunks.map((c) => c.heading);
  assert(headings.includes("Title"), "Title section present");
  assert(headings.includes("Section A"), "Section A present");
  assert(headings.includes("Section B"), "Section B present");
  // seq is 0-based and strictly increasing.
  assertEquals(chunks.map((c) => c.seq), chunks.map((_, i) => i));
  // Each chunk carries its own heading line.
  const a = chunks.find((c) => c.heading === "Section A")!;
  assert(a.content.includes("Body of A."));
});

Deno.test("chunk: does NOT split inside a fenced code block", () => {
  const code = Array.from({ length: 40 }, (_, i) => `line ${i} ${"x".repeat(60)}`).join("\n");
  const md = `# Doc\n\n## Code\n\n\`\`\`\n# this hash is NOT a heading\n${code}\n\`\`\`\n`;
  const chunks = chunkMarkdown(md, "Doc");
  // The "# this hash is NOT a heading" line inside the fence must not
  // start a new section.
  assert(
    !chunks.some((c) => c.heading === "this hash is NOT a heading"),
    "fenced '#' line was wrongly treated as a heading",
  );
});

Deno.test("chunk: sub-splits a section longer than MAX_CHUNK_CHARS", () => {
  const para = "Sentence. ".repeat(60); // ~600 chars
  const paras = Array.from({ length: 6 }, () => para).join("\n\n"); // ~3600 chars
  const md = `## Big\n\n${paras}`;
  const chunks = chunkMarkdown(md, "Doc");
  const bigChunks = chunks.filter((c) => c.heading === "Big");
  assert(bigChunks.length >= 2, "long section should sub-split into >=2 chunks");
  for (const c of bigChunks) {
    assert(c.content.length <= MAX_CHUNK_CHARS, `chunk over limit: ${c.content.length}`);
  }
});

Deno.test("chunk: every sub-split chunk carries its section heading (context)", () => {
  const para = "Sentence here. ".repeat(50); // ~750 chars
  const paras = Array.from({ length: 6 }, () => para).join("\n\n"); // ~4500 chars
  const md = `## Big Topic\n\n${paras}`;
  const chunks = chunkMarkdown(md, "Doc");
  const big = chunks.filter((c) => c.heading === "Big Topic");
  assert(big.length >= 2, "long section must sub-split");
  for (const c of big) {
    assert(c.content.includes("Big Topic"), "every sub-chunk embeds its heading");
    assert(c.content.length <= MAX_CHUNK_CHARS, `chunk over cap incl. prefix: ${c.content.length}`);
  }
});

Deno.test("chunk: empty / whitespace doc yields no chunks", () => {
  assertEquals(chunkMarkdown("   \n\n  ", ""), []);
});

Deno.test("contentHash: stable + sensitive to change", async () => {
  const a = await contentHash("hello world");
  const a2 = await contentHash("hello world");
  const b = await contentHash("hello world!");
  assertEquals(a, a2, "same input → same hash");
  assert(a !== b, "changed input → different hash");
  assertEquals(a.length, 64, "sha-256 hex is 64 chars");
});
