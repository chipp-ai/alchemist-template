/**
 * Guardrail: the file-storage guidance keeps its hub-and-spoke shape.
 *
 * The hub CLAUDE.md is prepended to every ticket worker's system prompt
 * and read natively by the persistent runtime and the project agent. The
 * DECISION rules (where a file belongs, how to recognize a file
 * requirement, how to honor a customer's namespace) must stay there, eager.
 * The MECHANICS (storage.service.ts recipes, the paved-road upload layer)
 * live in `.claude/rules/files.md`, which loads only when storage code is
 * touched. A refactor that drops either half, or moves the decision rules
 * into the lazy spoke, silently removes them from the prompt.
 */
import { assert } from "@std/assert";

const deno = Deno.test;
// Prose gets re-wrapped; assert on words, not on line breaks.
const read = async (rel: string) => (await Deno.readTextFile(new URL(rel, import.meta.url))).replace(/\s+/g, " ");

deno("files guidance: the hub carries the decision rules", async () => {
  const hub = await read("../../CLAUDE.md");
  assert(hub.includes("## Files: decide, detect, name"), "hub must keep the decision section");
  for (const h of ["### Where a file belongs", "### How to recognize a file requirement", "### Namespaces the customer wants"]) {
    assert(hub.includes(h), `hub must keep '${h}'`);
  }
  // The rule that catches the most common failure must survive verbatim.
  assert(hub.includes("will a human or another system open this later"), "hub must keep the R2 test question");
  assert(hub.includes("Never ask which storage technology to use"), "hub must keep the one-question rule");
});

deno("files guidance: the mechanics live in the spoke, and the hub points at it", async () => {
  const hub = await read("../../CLAUDE.md");
  const spoke = await read("../../.claude/rules/files.md");
  assert(hub.includes(".claude/rules/files.md"), "hub must point at the spoke");
  assert(!hub.includes("## File storage — use `storage.service.ts`"), "recipes must not be duplicated back into the hub");
  assert(spoke.startsWith("--- name: files "), "spoke needs frontmatter");
  assert(/ paths: (- "[^"]+" )+---/.test(spoke), "spoke must declare paths, or it costs what the hub costs");
  for (const s of ["## File storage", "## File uploads: use the paved road", "scopedKey", "orgScopedRawKey"]) {
    assert(spoke.includes(s), `spoke must keep '${s}'`);
  }
});
