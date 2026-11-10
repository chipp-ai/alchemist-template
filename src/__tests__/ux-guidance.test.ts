/**
 * Guardrail: the consumer UX spoke stays wired in.
 *
 * `.claude/rules/ux.md` is how every page and component agent learns the UX
 * bar (states, feedback, words, actions, layout, done means seen). It only
 * loads when its `paths:` match, so a frontmatter edit that drops the
 * Svelte or Astro globs silently removes it from every UI change. The hub
 * lists it and the verification checklist points at it. The toast store it
 * names is pinned against the code so a rename cannot leave it stale.
 */
import { assert } from "@std/assert";

const read = async (rel: string) =>
  (await Deno.readTextFile(new URL(rel, import.meta.url))).replace(/\s+/g, " ");

// CLAUDE.md is a short index since 2026-11-10; each topic lives in
// docs/conventions/<topic>.md. The guidance is the index plus the topic
// files, and the index must list every one of them.
const readGuide = async (...topics: string[]) => {
  const index = await read("../../CLAUDE.md");
  for (const t of topics) {
    const file = t.split("/").pop()!;
    if (!index.includes(`| \`${file}\` |`)) throw new Error(`CLAUDE.md must list ${file} in Topics`);
  }
  return [index, ...(await Promise.all(topics.map((t) => read(t))))].join(" ");
};

Deno.test("ux guidance: the spoke loads for every page and component", async () => {
  const spoke = await read("../../.claude/rules/ux.md");
  for (const glob of ['"web/src/**/*.svelte"', '"landing/src/**/*.astro"']) {
    assert(spoke.includes(glob), `ux.md paths must include ${glob}`);
  }
  for (const h of ["## States", "## Feedback", "## Words", "## Actions and chrome", "## Layout", "## Done means seen"]) {
    assert(spoke.includes(h), `ux.md must keep '${h}'`);
  }
  assert(spoke.includes("One state, one message."), "ux.md must keep the one-state rule");
  assert(spoke.includes("No time promises"), "ux.md must keep the no-time-promises rule");
});

Deno.test("ux guidance: the hub lists the spoke and the checklist points at it", async () => {
  const hub = await readGuide("../../docs/conventions/rule-spokes.md", "../../docs/conventions/verification.md");
  assert(hub.includes("| `ux.md` |"), "the spokes table must list ux.md");
  assert(hub.includes("against `.claude/rules/ux.md`"), "the verification checklist must point at ux.md");
});

Deno.test("ux guidance: the toast store it names exists", async () => {
  const store = await read("../../web/src/stores/toast.svelte.ts");
  assert(store.includes("toastStore"), "web/src/stores/toast.svelte.ts must export toastStore");
});
