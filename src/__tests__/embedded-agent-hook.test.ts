/**
 * embedded-chipp-agent feature hook (source-shape test, no DB).
 *
 * The embedded-chipp-agent pack replaces src/services/embedded-agent/
 * router.ts WHOLESALE. The install analyzer treats a file that still holds
 * the base content as untouched, so turning the feature on is a clean apply.
 * The contract between the stub and app.ts must not drift:
 *
 *   A. router.ts exports `embeddedAgentRouter`.
 *   B. app.ts mounts it at /api/embedded-agent.
 *
 * Both hold in a project with the pack installed too, so this test stays
 * green after the stub is replaced.
 */
import { assert } from "@std/assert";

const ROOT = new URL("../../", import.meta.url);

Deno.test("embedded-agent hook: the stub exports embeddedAgentRouter", async () => {
  const src = await Deno.readTextFile(new URL("src/services/embedded-agent/router.ts", ROOT));
  assert(/export const embeddedAgentRouter\b/.test(src));
});

Deno.test("embedded-agent hook: app.ts mounts the stub at /api/embedded-agent", async () => {
  const src = await Deno.readTextFile(new URL("app.ts", ROOT));
  assert(src.includes('import { embeddedAgentRouter } from "@/services/embedded-agent/router.ts";'));
  assert(src.includes('app.route("/api/embedded-agent", embeddedAgentRouter);'));
});

