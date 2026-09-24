/**
 * Guardrail: the tenant-context guidance keeps its hub-and-spoke shape.
 *
 * The hub CLAUDE.md is prepended to every ticket worker's system prompt.
 * The DECISION rules (pages fetch in onMount and rely on the Router key;
 * a switcher calls runContextSwitch() after the server confirms; never a
 * per-page org-id watch) must stay there, eager. The MECHANICS and the
 * switcher checklist live in `.claude/rules/frontend-state.md`, which
 * loads only when frontend state code is touched. A refactor that drops
 * either half silently removes the rule from the prompt, and the next
 * generated switcher ships the stale-tenant bug.
 */
import { assert } from "@std/assert";

const read = async (rel: string) => (await Deno.readTextFile(new URL(rel, import.meta.url))).replace(/\s+/g, " ");

Deno.test("context-switch guidance: the hub carries the decision rules", async () => {
  const hub = await read("../../CLAUDE.md");
  assert(hub.includes("### Tenant and route context: the Router key, not per-page watches"), "hub must keep the tenant-context section");
  for (const s of [
    "keys every `<Router>`",
    "runContextSwitch()",
    "MUST call it after the server acknowledged the switch",
    "Never key a refetch on an org or workspace id",
    "registerContextReset",
  ]) {
    assert(hub.includes(s), `hub must keep '${s}'`);
  }
  assert(hub.includes("| `frontend-state.md` |"), "hub's spoke table must list frontend-state.md");
  assert(hub.includes("or logout must call `runContextSwitch()` AFTER the server confirms"), "hub's Common Pitfalls must keep the one-line tripwire");
});

Deno.test("context-switch guidance: the mechanics live in the spoke, and the hub points at it", async () => {
  const hub = await read("../../CLAUDE.md");
  const spoke = await read("../../.claude/rules/frontend-state.md");
  assert(hub.includes(".claude/rules/frontend-state.md"), "hub must point at the spoke");
  assert(spoke.startsWith("--- name: frontend-state "), "spoke needs frontmatter");
  assert(/ paths: (- "[^"]+" )+---/.test(spoke), "spoke must declare paths, or it costs what the hub costs");
  for (const s of ['- "web/src/App.svelte"', '- "web/src/routes/**"', '- "web/src/stores/**"', '- "web/src/lib/query.svelte.ts"']) {
    assert(spoke.includes(s), `spoke must load for ${s}`);
  }
  for (const s of ["## The contract", "## Adding a switcher", "## Query keys stay tenant-free", "## Param-driven detail pages", "resetQueries()"]) {
    assert(spoke.includes(s), `spoke must keep '${s}'`);
  }
});
