/**
 * Guardrail: the event guidance keeps its hub-and-spoke shape.
 *
 * The hub CLAUDE.md is every agent's system prompt. The DECISION rules
 * (what is an event, publish inside the transaction, idempotent and
 * order-tolerant handlers, noun.past_tense topics, what is NOT an event)
 * must stay there, eager. The MECHANICS (signatures, the consumer loop,
 * the inbox, webhooks, the migration) live in `.claude/rules/events.md`
 * and load only when event code is touched. A refactor that drops either
 * half, moves the decision rules into the lazy spoke, or re-introduces
 * LISTEN / advisory locks / Redis-as-the-log silently removes the lesson
 * from the prompt. The spoke's signatures are pinned against the code so
 * a rename cannot leave the guidance describing a function that is gone.
 */
import { assert } from "@std/assert";

const deno = Deno.test;
// Prose gets re-wrapped; assert on words, not on line breaks.
const read = async (rel: string) =>
  (await Deno.readTextFile(new URL(rel, import.meta.url))).replace(/\s+/g, " ");

deno("events guidance: the hub carries the decision rules", async () => {
  const hub = await read("../../CLAUDE.md");
  assert(
    hub.includes("## Events: publish in the transaction, handle idempotently"),
    "hub must keep the decision section",
  );
  for (
    const h of [
      "### How to recognize an event",
      "### The rules",
      "### Adding an outbound webhook",
      "### The three tables, and what an operator can do",
    ]
  ) {
    assert(hub.includes(h), `hub must keep '${h}'`);
  }
  // The rules that catch the most common failures must survive verbatim.
  assert(
    hub.includes("is an event plus a handler, not a scheduler"),
    "hub must keep the ticket-shape test",
  );
  assert(
    hub.includes("goes INSIDE the transaction that made the change, never after it"),
    "hub must keep the publish-in-transaction rule",
  );
  assert(
    hub.includes("Handlers are idempotent and order-tolerant"),
    "hub must keep the idempotency rule",
  );
  assert(hub.includes("Topics are `noun.past_tense`"), "hub must keep the topic naming rule");
  assert(hub.includes("What is NOT an event"), "hub must keep the exclusions");
  assert(
    hub.includes("A request/response") && hub.includes("A cache fill"),
    "the two named non-events must survive",
  );
  assert(
    hub.includes("Never LISTEN, never `pg_advisory_lock`, never Redis as the log"),
    "the pgbouncer and durability reversals must survive",
  );
  for (
    const t of [
      "`events`",
      "`event_subscriptions`",
      "`event_deliveries`",
      "Inspect dead letters",
      "Replay one",
    ]
  ) {
    assert(hub.includes(t), `hub must keep '${t}' in the operator section`);
  }
});

deno("events guidance: the mechanics live in the spoke, and the hub points at it", async () => {
  const hub = await read("../../CLAUDE.md");
  const spoke = await read("../../.claude/rules/events.md");
  assert(hub.includes(".claude/rules/events.md"), "hub must point at the spoke");
  assert(
    !hub.includes("export async function claimDeliveries"),
    "signatures must not be duplicated back into the hub",
  );
  assert(spoke.startsWith("--- name: events "), "spoke needs frontmatter");
  assert(
    / paths: (- "[^"]+" )+---/.test(spoke),
    "spoke must declare paths, or it costs what the hub costs",
  );
  for (
    const p of [
      '"src/lib/events.ts"',
      '"src/jobs/event-consumer.ts"',
      '"src/api/routes/events/**"',
      '"db/migrations/*_events.sql"',
    ]
  ) {
    assert(spoke.includes(p), `spoke must cover ${p}`);
  }
  for (
    const s of [
      "## Publishing",
      "## Registering handlers",
      "## The consumer",
      "## Claim, complete, fail, replay",
      "## Outbound webhooks",
      "## Inbox",
      "## The migration",
    ]
  ) {
    assert(spoke.includes(s), `spoke must keep '${s}'`);
  }
});

deno("events guidance: the spoke's signatures match the code", async () => {
  const spoke = await read("../../.claude/rules/events.md");
  const events = await read("../lib/events.ts");
  const webhooks = await read("../lib/event-webhooks.ts");
  const signing = await read("../lib/event-signing.ts");
  const consumer = await read("../jobs/event-consumer.ts");
  const pinned: Array<[string, string, string]> = [
    [
      "events.ts",
      events,
      "export async function publishEvent( trx: Kysely<Database>, input: PublishEventInput, ): Promise<PublishResult>",
    ],
    ["events.ts", events, "export async function nudge(topic: string): Promise<void>"],
    [
      "events.ts",
      events,
      "export async function publishEventAndNudge(input: PublishEventInput): Promise<PublishResult>",
    ],
    [
      "events.ts",
      events,
      "export async function claimDeliveries( batch: number, opts: ClaimOptions, ): Promise<ClaimedDelivery[]>",
    ],
    [
      "events.ts",
      events,
      "export async function replayDelivery(deliveryId: string): Promise<boolean>",
    ],
    [
      "events.ts",
      events,
      "export async function requeueStaleDeliveries(staleAfterMs: number): Promise<number>",
    ],
    [
      "events.ts",
      events,
      "export async function sweepEventRetention(opts: RetentionOptions): Promise<RetentionResult>",
    ],
    ["event-webhooks.ts", webhooks, "export function validateWebhookUrl(raw: string): string"],
    [
      "event-webhooks.ts",
      webhooks,
      "export async function deactivateWebhookSubscription( organizationId: string, subscriptionId: string, ): Promise<void>",
    ],
    [
      "event-signing.ts",
      signing,
      "export function signEventBody(secret: string, timestampSeconds: number, rawBody: string): string",
    ],
    [
      "event-consumer.ts",
      consumer,
      "export function startEventConsumer(opts: EventConsumerOptions = {}): void",
    ],
    ["event-consumer.ts", consumer, "export async function stopEventConsumer(): Promise<void>"],
  ];
  for (const [file, src, sig] of pinned) {
    assert(src.includes(sig), `${file} must still export: ${sig}`);
    // The spoke quotes the same name and parameter list (defaults elided).
    const name = sig.match(/function (\w+)/)![1];
    assert(spoke.includes(`${name}(`), `spoke must document ${name}`);
  }
  // The spoke's single-line signature for the transactional publish must be exact.
  assert(
    spoke.includes(
      "export async function publishEvent(trx: Kysely<Database>, input: PublishEventInput): Promise<PublishResult>",
    ),
    "spoke must quote publishEvent verbatim",
  );
});

deno("events guidance: the code keeps the properties the hub promises", async () => {
  const events = await read("../lib/events.ts");
  const consumer = await read("../jobs/event-consumer.ts");
  assert(events.includes("FOR UPDATE SKIP LOCKED"), "claims must use SKIP LOCKED");
  assert(
    !/\bLISTEN\b(?![^.]*(never|not available|unavailable))/i.test(
      events.replace(/\/\*[\s\S]*?\*\//g, ""),
    ),
    "events.ts must not LISTEN",
  );
  assert(!/pg_(try_)?advisory_lock\(/.test(events), "events.ts must not take an advisory lock");
  assert(
    !/pg_(try_)?advisory_lock\(/.test(consumer),
    "the consumer must not take an advisory lock",
  );
  assert(
    consumer.includes("acquireLock(CONSUMER_LOCK_NAME") &&
      consumer.includes('CONSUMER_LOCK_NAME = "event-consumer"'),
    "the consumer must take the Redis tick lock",
  );
  assert(
    events.includes("export function registerEventHandler( topic: string, fn: EventHandler"),
    "registry must stay handler-first",
  );
  const handlers = await read("../events/handlers.ts");
  assert(
    handlers.includes("export function registerEventHandlers(): void"),
    "the handler scaffold must keep its entry point",
  );
});
