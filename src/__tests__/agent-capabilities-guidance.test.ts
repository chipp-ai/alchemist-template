/**
 * Guardrail: the hub CLAUDE.md names every capability switch in
 * chipp/agent.json, so a build agent turns a switch on instead of building
 * its own image, video, search, research, voice or upload feature.
 *
 * The switch names are owned by the platform
 * (chipp-deno src/alchemist/types/project-chipp-agent.ts); keep this list
 * in step with PROJECT_CHIPP_AGENT_CAPABILITY_KEYS there.
 */
import { assert } from "@std/assert";

const read = async (rel: string) =>
  (await Deno.readTextFile(new URL(rel, import.meta.url))).replace(/\s+/g, " ");

Deno.test("agent capabilities guidance: the hub names every switch", async () => {
  const hub = await read("../../CLAUDE.md");
  for (const key of ["webSearch", "imageGeneration", "videoGeneration", "deepResearch", "voice", "fileUploads"]) {
    assert(hub.includes(`\`${key}\``), `CLAUDE.md must name the ${key} switch`);
  }
  assert(hub.includes("never build a workaround"), "the deep research plan gate must stay explicit");
});
