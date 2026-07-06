/**
 * Service tests for the inbound-email extraction pipeline:
 *   - profile registry semantics (register / get / clear / double-register)
 *   - triage-schema construction rules (nullish, softText truncation)
 *   - batch drain dormancy with no profile registered
 *   - full extraction happy path + terminal status transitions, driven
 *     through a stubbed LLM fetch (the extraction client exposes
 *     `__setLlmConfigOverrideForTest` because LLM_CONFIG is frozen at
 *     module load) -- no real network, no real proxy.
 *   - CREDITS_EXHAUSTED (402) backoff gating the batch drain.
 *
 * NOTE: inbound_email rows here use organization_id NULL, so every
 * created row is deleted explicitly in finally blocks.
 */

import { assertEquals, assertExists, assertThrows } from "@std/assert";
import { z } from "zod";
import { db } from "@/db/client.ts";
import "../helpers.ts"; // provisions the per-worker test schema
import {
  clearInboundEmailExtractionProfileForTest,
  getInboundEmailExtractionProfile,
  type InboundEmailApplyResult,
  registerInboundEmailExtractionProfile,
} from "@/services/inbound-email/profile.ts";
import {
  __clearCreditsBackoffForTest,
  buildTriageSchema,
  buildTriageSystemPrompt,
  extractInboundEmail,
  processInboundEmailBatch,
  softText,
} from "@/services/inbound-email/extract.service.ts";
import {
  __resetLlmFetchForTest,
  __setLlmConfigOverrideForTest,
  __setLlmFetchForTest,
} from "@/services/llm/extraction.ts";

// ── Helpers ──────────────────────────────────────────────────────────────────

const testDataSchema = z.object({
  items: z.array(z.object({
    name: z.string().min(1).max(64),
    note: softText(100).nullish(),
  })).max(50),
});

function makeProfile(overrides: {
  dataKind?: string;
  applyData?: (input: {
    orgId: string | null;
    emailId: string;
    data: z.infer<typeof testDataSchema>;
  }) => Promise<InboundEmailApplyResult>;
} = {}) {
  return {
    dataKind: overrides.dataKind ?? "test_data",
    dataSchema: testDataSchema,
    extractionInstructions: "Extract each widget mentioned in the email as an item.",
    applyData: overrides.applyData ??
      ((_input: unknown) => Promise.resolve({ applied: 0 } as InboundEmailApplyResult)),
    // deno-lint-ignore no-explicit-any
  } as any;
}

async function insertReceivedEmail(bodyText: string): Promise<string> {
  const row = await db
    .insertInto("inbound_email")
    .values({
      messageId: `extract-test:${crypto.randomUUID()}`,
      subject: "extract test",
      bodyText,
      status: "received",
      attachmentCount: 0,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  return row.id;
}

async function deleteEmail(id: string | null): Promise<void> {
  if (!id) return;
  await db.deleteFrom("inbound_email").where("id", "=", id).execute();
}

/** Canned Anthropic Messages response with one forced tool_use block. */
function toolUseResponse(result: unknown, toolName = "triage_email"): Response {
  return new Response(
    JSON.stringify({
      id: "msg_test",
      model: "claude-test",
      role: "assistant",
      stop_reason: "tool_use",
      content: [{ type: "tool_use", id: "tu_1", name: toolName, input: { result } }],
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

/** Point the extraction client at a fake proxy + a canned fetch. */
function stubLlm(respond: (req: { url: string; body: unknown }) => Response): void {
  __setLlmConfigOverrideForTest({
    baseUrl: "https://llm-proxy.test",
    proxyToken: "test-proxy-token",
    tenantId: "test-tenant",
  });
  __setLlmFetchForTest(
    ((input: Request | URL | string, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      return Promise.resolve(respond({ url, body }));
    }) as typeof fetch,
  );
}

function unstubLlm(): void {
  __resetLlmFetchForTest();
  __setLlmConfigOverrideForTest(null);
}

// ── Profile registry ─────────────────────────────────────────────────────────

Deno.test({
  name: "profile registry: register/get/clear + double-register with different kind throws",
  sanitizeResources: false,
  sanitizeOps: false,
  fn() {
    clearInboundEmailExtractionProfileForTest();
    try {
      assertEquals(getInboundEmailExtractionProfile(), null);

      const profile = makeProfile();
      registerInboundEmailExtractionProfile(profile);
      assertEquals(getInboundEmailExtractionProfile()?.dataKind, "test_data");

      // Same dataKind re-registration is an idempotent replace...
      registerInboundEmailExtractionProfile(makeProfile());
      assertEquals(getInboundEmailExtractionProfile()?.dataKind, "test_data");

      // ...but a DIFFERENT dataKind is a wiring bug and throws.
      assertThrows(
        () => registerInboundEmailExtractionProfile(makeProfile({ dataKind: "other_data" })),
        Error,
        "already registered",
      );

      // Reserved kinds are rejected outright.
      assertThrows(
        () => registerInboundEmailExtractionProfile(makeProfile({ dataKind: "human_message" })),
        Error,
        "reserved",
      );

      clearInboundEmailExtractionProfileForTest();
      assertEquals(getInboundEmailExtractionProfile(), null);
    } finally {
      clearInboundEmailExtractionProfileForTest();
    }
  },
});

// ── Triage schema construction (pure) ────────────────────────────────────────

Deno.test({
  name:
    "triage schema: data variant validates via profile schema; soft fields truncate; nullish accepts null",
  sanitizeResources: false,
  sanitizeOps: false,
  fn() {
    const schema = buildTriageSchema(makeProfile());

    // Valid data variant round-trips.
    const data = schema.parse({
      kind: "test_data",
      data: { items: [{ name: "widget-a", note: null }] },
    });
    assertEquals(data.kind, "test_data");
    assertEquals(data.data.items[0].name, "widget-a");

    // Invalid payload against the profile schema rejects.
    assertThrows(() => schema.parse({ kind: "test_data", data: { items: [{ name: "" }] } }));
    // Unknown kind rejects.
    assertThrows(() => schema.parse({ kind: "mystery", data: {} }));

    // human_message: explicit nulls accepted (nullish, not optional), and
    // an over-long summary TRUNCATES instead of rejecting.
    const long = "x".repeat(5000);
    const hm = schema.parse({
      kind: "human_message",
      summary: long,
      urgency: null,
      wantsReply: null,
    });
    assertEquals(hm.summary.length, 1000);

    // unclear: reason truncates to 500.
    const uc = schema.parse({ kind: "unclear", reason: long });
    assertEquals(uc.reason.length, 500);

    // The system prompt names the profile's kind + appends its guidance.
    const prompt = buildTriageSystemPrompt(makeProfile());
    assertEquals(prompt.includes('"test_data"'), true);
    assertEquals(prompt.includes("Extract each widget"), true);
  },
});

// ── Batch dormancy (no profile) ──────────────────────────────────────────────

Deno.test({
  name: "processInboundEmailBatch: no profile -> no-profile skip, rows stay received",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    clearInboundEmailExtractionProfileForTest();
    __clearCreditsBackoffForTest();
    let emailId: string | null = null;
    try {
      emailId = await insertReceivedEmail("dormant row");

      const result = await processInboundEmailBatch();
      assertEquals(result.skipped, "no-profile");
      assertEquals(result.claimed, 0);
      assertEquals(result.processed, 0);

      const row = await db
        .selectFrom("inbound_email")
        .select(["status", "processedAt"])
        .where("id", "=", emailId)
        .executeTakeFirstOrThrow();
      assertEquals(row.status, "received");
      assertEquals(row.processedAt, null);

      // extractInboundEmail also refuses to touch the row without a profile.
      const outcome = await extractInboundEmail(emailId);
      assertEquals(outcome, "no-profile");
      const row2 = await db
        .selectFrom("inbound_email")
        .select("status")
        .where("id", "=", emailId)
        .executeTakeFirstOrThrow();
      assertEquals(row2.status, "received");
    } finally {
      await deleteEmail(emailId);
      clearInboundEmailExtractionProfileForTest();
    }
  },
});

// ── Full extraction happy path (stubbed LLM) ─────────────────────────────────

Deno.test({
  name:
    "extractInboundEmail: data kind -> applyData invoked, status extracted + apply_result persisted",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    clearInboundEmailExtractionProfileForTest();
    __clearCreditsBackoffForTest();
    let emailId: string | null = null;
    const applyCalls: { orgId: string | null; emailId: string; data: unknown }[] = [];
    try {
      registerInboundEmailExtractionProfile(makeProfile({
        applyData: (input) => {
          applyCalls.push(input);
          return Promise.resolve({ applied: 2, deferred: 1, summary: "2 widgets applied" });
        },
      }));
      emailId = await insertReceivedEmail("widget-a and widget-b arrived");

      stubLlm(({ body }) => {
        // The request must carry the forced tool choice + our system prompt.
        const b = body as {
          tool_choice: { type: string; name: string };
          system: string;
          max_tokens: number;
        };
        assertEquals(b.tool_choice, { type: "tool", name: "triage_email" });
        assertEquals(b.system.includes("Extract each widget"), true);
        assertEquals(b.max_tokens, 8192);
        return toolUseResponse({
          kind: "test_data",
          data: { items: [{ name: "widget-a" }, { name: "widget-b", note: null }] },
        });
      });

      const outcome = await extractInboundEmail(emailId);
      assertEquals(outcome, "extracted");

      // applyData saw the parsed payload + null org + the row id.
      assertEquals(applyCalls.length, 1);
      assertEquals(applyCalls[0].emailId, emailId);
      assertEquals(applyCalls[0].orgId, null);
      assertEquals(
        (applyCalls[0].data as { items: { name: string }[] }).items.map((i) => i.name),
        ["widget-a", "widget-b"],
      );

      const row = await db
        .selectFrom("inbound_email")
        .select(["status", "statusReason", "applyResult", "processedAt"])
        .where("id", "=", emailId)
        .executeTakeFirstOrThrow();
      assertEquals(row.status, "extracted");
      assertEquals(row.statusReason, "2 widgets applied");
      assertExists(row.processedAt);
      assertEquals(row.applyResult, { applied: 2, deferred: 1, summary: "2 widgets applied" });
    } finally {
      unstubLlm();
      clearInboundEmailExtractionProfileForTest();
      await deleteEmail(emailId);
    }
  },
});

Deno.test({
  name: "extractInboundEmail: human_message -> terminal status with summary as reason",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    clearInboundEmailExtractionProfileForTest();
    __clearCreditsBackoffForTest();
    let emailId: string | null = null;
    try {
      registerInboundEmailExtractionProfile(makeProfile());
      emailId = await insertReceivedEmail("Hey, can you resend the report?");

      stubLlm(() =>
        toolUseResponse({
          kind: "human_message",
          summary: "Asks for the report to be resent",
          urgency: "normal",
          wantsReply: true,
        })
      );

      const outcome = await extractInboundEmail(emailId);
      assertEquals(outcome, "human_message");

      const row = await db
        .selectFrom("inbound_email")
        .select(["status", "statusReason", "applyResult", "processedAt"])
        .where("id", "=", emailId)
        .executeTakeFirstOrThrow();
      assertEquals(row.status, "human_message");
      assertEquals(row.statusReason, "Asks for the report to be resent");
      assertEquals(row.applyResult, null);
      assertExists(row.processedAt);
    } finally {
      unstubLlm();
      clearInboundEmailExtractionProfileForTest();
      await deleteEmail(emailId);
    }
  },
});

Deno.test({
  name: "extractInboundEmail: applyData failure -> status failed with reason, row re-runnable",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    clearInboundEmailExtractionProfileForTest();
    __clearCreditsBackoffForTest();
    let emailId: string | null = null;
    try {
      registerInboundEmailExtractionProfile(makeProfile({
        applyData: () => Promise.reject(new Error("downstream table is on fire")),
      }));
      emailId = await insertReceivedEmail("widget-c arrived");

      stubLlm(() =>
        toolUseResponse({ kind: "test_data", data: { items: [{ name: "widget-c" }] } })
      );

      const outcome = await extractInboundEmail(emailId);
      assertEquals(outcome, "failed");

      const row = await db
        .selectFrom("inbound_email")
        .select(["status", "statusReason"])
        .where("id", "=", emailId)
        .executeTakeFirstOrThrow();
      assertEquals(row.status, "failed");
      assertEquals(row.statusReason?.includes("downstream table is on fire"), true);
      assertEquals(row.statusReason?.startsWith("applyData failed"), true);
    } finally {
      unstubLlm();
      clearInboundEmailExtractionProfileForTest();
      await deleteEmail(emailId);
    }
  },
});

// ── CREDITS_EXHAUSTED backoff ────────────────────────────────────────────────

Deno.test({
  name: "extractInboundEmail: 402 CREDITS_EXHAUSTED -> row failed + batch drain backs off",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    clearInboundEmailExtractionProfileForTest();
    __clearCreditsBackoffForTest();
    let emailId: string | null = null;
    try {
      registerInboundEmailExtractionProfile(makeProfile());
      emailId = await insertReceivedEmail("widget-d arrived");

      stubLlm(() =>
        new Response(
          JSON.stringify({ error: "CREDITS_EXHAUSTED", message: "tenant balance depleted" }),
          { status: 402, headers: { "content-type": "application/json" } },
        )
      );

      const outcome = await extractInboundEmail(emailId);
      assertEquals(outcome, "failed");

      const row = await db
        .selectFrom("inbound_email")
        .select(["status", "statusReason"])
        .where("id", "=", emailId)
        .executeTakeFirstOrThrow();
      assertEquals(row.status, "failed");
      assertEquals(row.statusReason?.includes("402"), true);

      // The drain now skips entirely (no claim, no LLM spend) until the
      // backoff window elapses or a success clears it.
      const batch = await processInboundEmailBatch();
      assertEquals(batch.skipped, "credits-backoff");
      assertEquals(batch.claimed, 0);

      // Clearing the backoff (as a successful extraction would) resumes
      // normal claiming behavior.
      __clearCreditsBackoffForTest();
      stubLlm(() => toolUseResponse({ kind: "unclear", reason: "nothing extractable" }));
      const outcome2 = await extractInboundEmail(emailId);
      assertEquals(outcome2, "unclear");
      const row2 = await db
        .selectFrom("inbound_email")
        .select(["status", "statusReason"])
        .where("id", "=", emailId)
        .executeTakeFirstOrThrow();
      assertEquals(row2.status, "unclear");
      assertEquals(row2.statusReason, "nothing extractable");
    } finally {
      unstubLlm();
      clearInboundEmailExtractionProfileForTest();
      __clearCreditsBackoffForTest();
      await deleteEmail(emailId);
    }
  },
});
