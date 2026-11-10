/**
 * Guardrail: the hub CLAUDE.md keeps the agent-tools rule.
 *
 * Every generated app ships an embedded Chipp agent, and its data access is
 * only as good as the tools each feature registers. The rule has to stay in
 * the eager hub, where every build agent reads it.
 */
import { assert } from "@std/assert";

// Prose gets re-wrapped; assert on words, not on line breaks.
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

Deno.test("agent tools guidance: the hub carries the rule", async () => {
  const hub = await readGuide("../../docs/conventions/embedded-agent.md");
  assert(hub.includes("## Embedded agent tools: register them for every feature"));
  assert(
    hub.includes(
      "When you build a feature, register agent tools for its routes in src/services/agent-tools/, " +
        "scoped by the session user's organization; mark writes write:true; never accept org or user ids " +
        "from tool args; never add raw SQL tools.",
    ),
    "hub must keep the rule sentence",
  );
  for (
    const s of [
      "registerAgentTool",
      "starter-tools.ts",
      "/api/agent-mcp",
      "embeddedAgentSessionExtras",
      "portalSafe",
    ]
  ) {
    assert(hub.includes(s), `hub must mention ${s}`);
  }
});
