/**
 * Dev-only surface gate — FAIL CLOSED.
 *
 * Gates the dev routes (`/api/dev/*`: instant login, DB seed/reset) and
 * the in-memory dev-activity ring buffers. These are OFF unless
 * `ALCHEMIST_DEV_ROUTES` is explicitly truthy ("1" or "true").
 *
 * Why a positive opt-in instead of the old `NODE_ENV !== "production"`
 * check: that gate was fail-OPEN. Any deployed pod that didn't have
 * NODE_ENV set to exactly "production" (e.g. a customer pod whose env
 * wiring is incomplete) exposed instant-login + DB reset to the public
 * internet. A positive flag that production never sets stays safe even
 * when the rest of the env is misconfigured.
 *
 * Local dev and the agent sandbox opt in by setting
 * ALCHEMIST_DEV_ROUTES=1 (wired into the `deno task dev` task). Nothing
 * in the customer deploy path sets it, so production is dead-by-default.
 */
export function devRoutesEnabled(): boolean {
  const v = Deno.env.get("ALCHEMIST_DEV_ROUTES");
  return v === "1" || v === "true";
}
