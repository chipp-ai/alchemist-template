/**
 * Guardrail: the Redis guidance in the hub keeps the lessons that cost us.
 *
 * The hub is every agent's system prompt. Two things must never regress:
 * the decision list (when Redis is the answer), and the reversal of the
 * old advice to use a Postgres advisory lock for cross-pod exclusion. That
 * advice jammed a production scheduler behind pgbouncer's transaction
 * pooling (2026-08-01), and it had been copied into 42 files across
 * customer repos by the time it was reversed. The scaffold reaper is the
 * file agents copy for the "poller" shape, so it is pinned too.
 */
import { assert } from "@std/assert";

const deno = Deno.test;
const read = async (rel: string) => (await Deno.readTextFile(new URL(rel, import.meta.url))).replace(/\s+/g, " ");

deno("redis guidance: the hub says when Redis is and is not the answer", async () => {
  const hub = await read("../../CLAUDE.md");
  assert(hub.includes("### When Redis is the answer, and when it is not"), "hub must keep the decision section");
  assert(hub.includes("A scheduled tick, poller, reaper or sweep"), "schedulers must be named as a lock case");
  assert(hub.includes("Losing it would be a bug"), "the durability exclusion must survive");
});

deno("redis guidance: cross-pod locks are Redis, never a Postgres advisory lock", async () => {
  const hub = await read("../../CLAUDE.md");
  assert(hub.includes("Never take a Postgres advisory lock"), "the reversal must survive");
  assert(!/For real mutual exclusion use a Postgres advisory lock/.test(hub), "the old advice must not come back");
  const helper = await read("../lib/redis.ts");
  assert(!/For real mutual exclusion use a Postgres advisory lock/.test(helper), "the helper docstring must not recommend advisory locks");
});

deno("redis guidance: the scaffold reaper uses the Redis lock, not an advisory lock", async () => {
  const reaper = await read("../jobs/inbound-email-reaper.ts");
  assert(reaper.includes("acquireLock(REAPER_LOCK_NAME"), "reaper must take the Redis lock");
  assert(!/select pg_try_advisory_lock/i.test(reaper), "reaper must not take a Postgres advisory lock");
});
