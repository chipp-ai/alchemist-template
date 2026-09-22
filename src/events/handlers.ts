/**
 * Event handlers: declared once, here, at boot.
 *
 * A ticket that says "when X happens, do Y" is an event and a handler,
 * not a scheduler. Publish X inside the transaction that makes it true
 * (src/lib/events.ts publishEvent), then declare Y below. The consumer
 * (src/jobs/event-consumer.ts) runs it at least once, retries with
 * backoff, dead-letters after the budget, and lets you replay.
 *
 * Rules every handler follows:
 *   - idempotent: it WILL run again after a crash or a stale claim, and
 *     it may see events out of order. Pass `idempotencyKey` when the
 *     side effect is not naturally idempotent (an email, a charge).
 *   - bounded: it must finish inside EVENTS_HANDLER_TIMEOUT_MS (30s by
 *     default) or the attempt fails. Long work publishes a follow-up
 *     event or writes a row for a job loop.
 *   - named: `registerEventHandler` stores the function name in
 *     event_subscriptions.handler, so renaming a handler deactivates the
 *     old subscription and creates a new one at the next boot.
 *
 * Example:
 *
 *   import { registerEventHandler } from "@/lib/events.ts";
 *   import { sendOrderConfirmation } from "@/services/orders/confirmation.service.ts";
 *
 *   registerEventHandler("order.created", sendOrderConfirmation, {
 *     retries: 8,
 *     idempotencyKey: (e) => e.id,
 *   });
 *
 * This function is called from main.ts before the consumer starts.
 * Registration is pure bookkeeping: no DB, no network, nothing that can
 * fail at boot. The template ships no handlers; add yours here.
 */

export function registerEventHandlers(): void {
  // registerEventHandler("order.created", sendOrderConfirmation, { retries: 8 });
}
