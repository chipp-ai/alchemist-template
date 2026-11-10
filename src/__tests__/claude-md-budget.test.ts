/**
 * Guardrail: CLAUDE.md stays a short index (2026-11-10).
 *
 * Every agent loads CLAUDE.md on every model call, before it does any work.
 * The template's copy had grown to 160K characters and a project's to 331K
 * (agents appended each learning to it), so a one-line message cost about
 * 190K tokens. The topics now live in docs/conventions/<topic>.md, read on
 * demand. This test keeps the index under budget and every topic it names
 * present. New learnings go into the matching docs/conventions file.
 */
import { assert } from "@std/assert";

const CLAUDE_MD_BUDGET_CHARS = 16_000;
const root = new URL("../../", import.meta.url);

Deno.test("CLAUDE.md stays under its character budget", async () => {
  const text = await Deno.readTextFile(new URL("CLAUDE.md", root));
  assert(
    text.length <= CLAUDE_MD_BUDGET_CHARS,
    `CLAUDE.md is ${text.length} characters; the budget is ${CLAUDE_MD_BUDGET_CHARS}. ` +
      "Move the detail into the matching docs/conventions/<topic>.md and keep one line here.",
  );
});

Deno.test("CLAUDE.md says where new learnings go", async () => {
  const text = (await Deno.readTextFile(new URL("CLAUDE.md", root))).replace(/\s+/g, " ");
  assert(
    text.includes(
      "New learnings go into the matching `docs/conventions/` file, never into this file.",
    ),
  );
});

Deno.test("every topic file CLAUDE.md names exists, and every topic file is named", async () => {
  const text = await Deno.readTextFile(new URL("CLAUDE.md", root));
  const named = new Set([...text.matchAll(/^\| `([a-z0-9-]+\.md)` \|/gm)].map((m) => m[1]));
  assert(named.size > 0, "CLAUDE.md lists no topic files");
  const present = new Set<string>();
  for await (const entry of Deno.readDir(new URL("docs/conventions/", root))) {
    if (entry.isFile && entry.name.endsWith(".md")) present.add(entry.name);
  }
  const missing = [...named].filter((f) => !present.has(f));
  const unlisted = [...present].filter((f) => !named.has(f));
  assert(
    missing.length === 0,
    `CLAUDE.md names topic files that do not exist: ${missing.join(", ")}`,
  );
  assert(
    unlisted.length === 0,
    `docs/conventions files missing from CLAUDE.md's Topics: ${unlisted.join(", ")}`,
  );
});
