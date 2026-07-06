/**
 * Inbound-email extraction -- Stage 2 of the capture-first pipeline.
 * Genericized port of the Valor Victoria customer repo's
 * src/services/vv/email/extract.service.ts (VV's domain routing replaced
 * by the pluggable extraction-profile seam in ./profile.ts).
 *
 * Captured `inbound_email` rows pile up at status='received'. This service
 * is the re-runnable PROJECTION on top of that immutable raw: it reads an
 * email's body + attachments, asks the billing-correct LLM client to
 * triage + extract (forced structured output against a discriminated
 * union built at runtime from the registered profile), hands domain data
 * to the profile's applyData(), and advances `inbound_email.status`.
 *
 * INVARIANTS:
 *   - The raw is IMMUTABLE. This service writes only the projection
 *     (whatever applyData does) + the inbound_email `status` /
 *     `status_reason` / `apply_result` / `processed_at` fields. It never
 *     mutates the body, attachment rows, or stored objects.
 *   - RE-RUN IDEMPOTENT. The no-double-write guarantee is the PROFILE's
 *     responsibility (applyData must be idempotent keyed on emailId --
 *     see profile.ts). This service never forks that contract.
 *   - TERMINAL STATUS ALWAYS SET (when a profile is registered). Every
 *     code path (success or thrown error) ends with one UPDATE setting a
 *     terminal status + processed_at, so a row can never re-loop forever.
 *     With NO profile registered rows are left untouched at 'received'
 *     (dormant mode -- extraction starts once a profile ships).
 *
 * # Schema-shape rules (learned the hard way upstream; keep them)
 *
 *   - LLM-optional fields use `.nullish()` (null OR absent), NEVER bare
 *     `.optional()`: models routinely emit an explicit `null` for an
 *     optional field rather than omitting it, and `.optional()` alone
 *     rejects `null` -- failing the whole extraction for a legitimate
 *     email.
 *   - Soft free-text DESCRIPTIVE fields (summary/reason blurbs) TRUNCATE
 *     to a cap via `softText(max)` rather than REJECT with `.max()`: a
 *     verbose-but-valid model value must never drop a real business
 *     email. (Upstream lost a legitimate ~10KB reply thread to a ZodError
 *     `too_big` retry loop before this rule.) Structured/identifier/enum
 *     fields stay STRICT -- an overflow there signals a model error and
 *     SHOULD fail.
 */

import { Buffer } from "node:buffer";
import { z } from "zod";
import { db, isTransientDbError, withTimeout } from "@/db/client.ts";
import { log } from "@/lib/logger.ts";
import type { InboundEmailStatus } from "@/db/schema.ts";
import {
  type ContentBlock,
  extractStructured,
  imageBlock,
  isTransientLlmError,
  LlmCreditsExhaustedError,
  pdfBlock,
  textBlock,
} from "@/services/llm/extraction.ts";
import { getObject } from "@/services/storage.service.ts";
import {
  getInboundEmailExtractionProfile,
  type InboundEmailApplyResult,
  type InboundEmailExtractionProfile,
} from "./profile.ts";
import { xlsxToCsv } from "./xlsx.ts";

const LOG_SOURCE = "inbound-email-extract";

// ── Triage schema (built at runtime from the registered profile) ─────────────

/**
 * Soft free-text DESCRIPTIVE LLM-output field: TRUNCATE to `max` rather
 * than REJECT. A non-string input still fails the leading `z.string()`
 * (a genuine type error -- model emitted a number/object). `.transform`
 * (input type `string`) is used deliberately over `z.preprocess` (input
 * type `unknown`) so the field's inferred type stays `string`.
 */
export const softText = (max: number) => z.string().transform((s) => s.trim().slice(0, max));

const humanMessageSchema = z.object({
  kind: z.literal("human_message"),
  // Soft descriptive field -- truncate rather than reject.
  summary: softText(1000),
  // .nullish(): models emit explicit null for optional enum fields.
  urgency: z.enum(["low", "normal", "high"]).nullish(),
  wantsReply: z.boolean().nullish(),
});

const unclearSchema = z.object({
  kind: z.literal("unclear"),
  // Soft descriptive field -- truncate rather than reject.
  reason: softText(500),
});

/** Parsed triage output shapes (the data variant's payload is profile-typed). */
export type TriageResult =
  | { kind: string; data: unknown }
  | {
    kind: "human_message";
    summary: string;
    urgency?: "low" | "normal" | "high" | null;
    wantsReply?: boolean | null;
  }
  | { kind: "unclear"; reason: string };

/**
 * Build the triage discriminated union from the registered profile:
 * one domain-data variant (`kind: profile.dataKind`, payload validated by
 * the profile's own schema) + the two generic variants.
 *
 * Exported for tests (pure -- no DB, no LLM).
 */
export function buildTriageSchema(profile: InboundEmailExtractionProfile): z.ZodTypeAny {
  const dataVariant = z.object({
    kind: z.literal(profile.dataKind),
    data: profile.dataSchema,
  });
  // Cast: z.discriminatedUnion's tuple typing can't express a runtime-
  // built literal member; the runtime discrimination is exactly what we
  // want and the payload is re-validated by the member schemas.
  return z.discriminatedUnion("kind", [
    dataVariant,
    humanMessageSchema,
    unclearSchema,
    // deno-lint-ignore no-explicit-any
  ] as any);
}

// ── System prompt ────────────────────────────────────────────────────────────

/**
 * Generic triage instructions. Domain guidance comes from the profile's
 * `extractionInstructions` (appended below); this base prompt owns only
 * classification + anti-fabrication + attachment mechanics.
 */
export function buildTriageSystemPrompt(profile: InboundEmailExtractionProfile): string {
  return [
    "You triage a forwarded email and, when it carries domain data, extract",
    "that data from its body and attachments. Classify the email into exactly",
    "one of three kinds:",
    "",
    `1. "${profile.dataKind}" -- the email (or an attachment) carries the domain`,
    "   data described in the extraction guidance below. Populate `data` per",
    "   that guidance and the tool schema.",
    '2. "human_message" -- a person is actually writing to the inbox (asking a',
    "   question, requesting a resend, replying), NOT reporting data. Summarize",
    "   what they want, how urgent it seems, and whether a reply is expected.",
    '3. "unclear" -- it looks like it should contain data but you cannot extract',
    "   anything reliable. Give a one-line reason.",
    "",
    "Rules:",
    "- NEVER invent values. Omit (or emit null for) any field you cannot read",
    "  from the email or its attachments. Prefer omitting a field over",
    "  fabricating one.",
    "- Attachments are provided as document/image blocks or inlined text",
    "  (spreadsheets arrive converted to CSV; unreadable or unarchived",
    "  attachments are named in a note). Read them as part of the email.",
    "- Quote the source line/cell in any evidence-style field when you can.",
    "",
    "Domain-specific extraction guidance:",
    profile.extractionInstructions,
  ].join("\n");
}

// ── Attachment -> content building ────────────────────────────────────────────

const INLINE_IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/gif",
  "image/webp",
]);

const PLAINTEXT_TYPES = new Set([
  "text/csv",
  "application/csv",
  "text/plain",
]);

const XLSX_TYPES = new Set([
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel",
  "application/vnd.ms-excel.sheet.macroenabled.12",
]);

/** Drop `; charset=...` params, lowercase, trim. Empty string when absent. */
function bareContentType(ct: string | null | undefined): string {
  return (ct ?? "").split(";")[0].trim().toLowerCase();
}

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

function isXlsx(ct: string, filename: string | null): boolean {
  if (XLSX_TYPES.has(ct)) return true;
  const fn = (filename ?? "").toLowerCase();
  return fn.endsWith(".xlsx") || fn.endsWith(".xls");
}

interface EmailRow {
  id: string;
  organizationId: string | null;
  fromAddress: string | null;
  toAddress: string | null;
  subject: string | null;
  bodyText: string | null;
  bodyHtml: string | null;
  receivedAt: Date;
}

interface AttachmentRow {
  filename: string | null;
  contentType: string | null;
  r2Key: string;
}

/** Loader seam -- defaults to storage getObject; injected in tests. */
type LoadObject = (relativeKey: string) => Promise<{ body: Uint8Array; contentType: string }>;

export interface InboundEmailExtractionDeps {
  loadObject?: LoadObject;
}

/**
 * Build the inline content block for a single attachment's bytes.
 * Returns `null` for attachment types that are not inline-readable
 * (callers push a "not readable" note in that case).
 */
export function attachmentContentBlock(
  ct: string,
  filename: string | null,
  bytes: Uint8Array,
): ContentBlock | null {
  const name = filename ?? "file";
  if (ct === "application/pdf") {
    return pdfBlock(toBase64(bytes));
  }
  if (INLINE_IMAGE_TYPES.has(ct)) {
    const mediaType = ct === "image/jpg" ? "image/jpeg" : ct;
    return imageBlock(mediaType, toBase64(bytes));
  }
  if (PLAINTEXT_TYPES.has(ct)) {
    const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    return textBlock(`Attachment ${name} (${ct || "text"}):\n${text}`);
  }
  if (isXlsx(ct, filename)) {
    const csv = xlsxToCsv(bytes);
    return textBlock(`Attachment ${name} (spreadsheet, converted to CSV):\n${csv}`);
  }
  return null; // not inline-readable
}

/**
 * Build the multimodal LLM content: a leading text block with sender /
 * recipient / subject / body, then one block per stored attachment
 * (PDF -> document block, image -> image block, CSV/text -> text block,
 * xls/xlsx -> CSV text block; anything else -> a text note). Attachments
 * that were never stored (`r2_key === ''`, the disallowed/oversized/
 * no-storage sentinel from capture) are named in a trailing note so the
 * model knows they existed. Always returns at least the body text block.
 */
export async function buildContent(
  email: EmailRow,
  attachments: AttachmentRow[],
  loadObject: LoadObject,
): Promise<ContentBlock[]> {
  const body = email.bodyText?.trim() || email.bodyHtml?.trim() || "(no body)";
  const blocks: ContentBlock[] = [
    textBlock(
      `From: ${email.fromAddress ?? "(unknown)"}\n` +
        `To: ${email.toAddress ?? "(unknown)"}\n` +
        `Subject: ${email.subject ?? "(no subject)"}\n\n` +
        body,
    ),
  ];

  const unavailable: string[] = [];
  for (const att of attachments) {
    if (!att.r2Key) {
      unavailable.push(att.filename ?? "unnamed");
      continue;
    }
    const ct = bareContentType(att.contentType);
    const { body: bytes } = await loadObject(att.r2Key);
    const name = att.filename ?? "file";
    const block = attachmentContentBlock(ct, att.filename, bytes);
    if (block) {
      blocks.push(block);
    } else {
      blocks.push(
        textBlock(
          `Attachment ${name} (${ct || "unknown type"}) is not inline-readable and was omitted.`,
        ),
      );
    }
  }

  if (unavailable.length > 0) {
    blocks.push(
      textBlock(
        `Note: ${unavailable.length} attachment(s) were not archived (disallowed type, ` +
          `oversized, or storage unavailable) and cannot be analyzed: ${unavailable.join(", ")}.`,
      ),
    );
  }
  return blocks;
}

// ── Status transitions ─────────────────────────────────────────────────────────

/**
 * Set the terminal status + processed_at in one UPDATE. `statusReason` is
 * cleared (null) on a clean outcome and carries the error on `failed` so
 * a re-pick by the reaper can later clear it. `applyResult` is persisted
 * only on the 'extracted' transition.
 */
async function setTerminalStatus(
  emailId: string,
  status: InboundEmailStatus,
  statusReason: string | null = null,
  applyResult: InboundEmailApplyResult | null = null,
): Promise<void> {
  await withTimeout(5_000, (trx) =>
    trx
      .updateTable("inbound_email")
      .set({
        status,
        statusReason,
        // Pass the object directly -- the postgres.js dialect serializes
        // JSONB params itself (JSON.stringify here double-encodes).
        applyResult,
        processedAt: new Date(),
      })
      .where("id", "=", emailId)
      .execute());
}

// ── CREDITS_EXHAUSTED backoff (in-memory, process-global) ─────────────────────

/**
 * Bounded backoff for 402 CREDITS_EXHAUSTED failures: the tenant's credit
 * balance is depleted (external action required), so re-running the LLM
 * every reaper tick would just thrash. The whole drain skips until the
 * window elapses; the next SUCCESSFUL extraction clears it early.
 * In-memory on purpose: a pod restart re-probing once is fine (one cheap
 * 402), and multi-pod drains are already serialized by the reaper's
 * advisory lock.
 */
export const CREDITS_EXHAUSTED_BACKOFF_MS = 3 * 24 * 60 * 60 * 1000; // 3 days

let creditsBackoffUntil = 0;
let creditsBackoffLogged = false;

function enterCreditsBackoff(): void {
  creditsBackoffUntil = Date.now() + CREDITS_EXHAUSTED_BACKOFF_MS;
  creditsBackoffLogged = false;
}

function clearCreditsBackoff(): void {
  creditsBackoffUntil = 0;
  creditsBackoffLogged = false;
}

/** Test hook -- reset the in-memory backoff state. */
export function __clearCreditsBackoffForTest(): void {
  clearCreditsBackoff();
}

// ── Public entry points ──────────────────────────────────────────────────────

export type ExtractionOutcome = InboundEmailStatus | "no-profile";

/**
 * Extract one captured inbound email, advancing its status.
 *
 * Loads the row, builds multimodal content, calls the LLM with the
 * profile-derived triage schema, dispatches the result, and sets the
 * terminal status. Any thrown error (storage load, LLM, parse, apply)
 * is caught -> status='failed', so a row never re-loops forever and the
 * reaper can re-pick it later.
 *
 * With NO profile registered, returns "no-profile" WITHOUT touching the
 * row -- dormant mode.
 */
export async function extractInboundEmail(
  emailId: string,
  deps: InboundEmailExtractionDeps = {},
): Promise<ExtractionOutcome> {
  const profile = getInboundEmailExtractionProfile();
  if (!profile) return "no-profile";

  const loadObject = deps.loadObject ?? getObject;

  const email = await db
    .selectFrom("inbound_email")
    .select([
      "id",
      "organizationId",
      "fromAddress",
      "toAddress",
      "subject",
      "bodyText",
      "bodyHtml",
      "receivedAt",
    ])
    .where("id", "=", emailId)
    .executeTakeFirst();

  if (!email) {
    log.warn("inbound-email extract: row not found", { source: LOG_SOURCE, emailId });
    return "failed";
  }

  try {
    const attachments = await db
      .selectFrom("inbound_email_attachment")
      .select(["filename", "contentType", "r2Key"])
      .where("inboundEmailId", "=", emailId)
      .orderBy("createdAt", "asc")
      .execute();

    const content = await buildContent(email, attachments, loadObject);
    const triage = await extractStructured({
      schema: buildTriageSchema(profile),
      content,
      system: buildTriageSystemPrompt(profile),
      toolName: "triage_email",
      // A data-heavy attachment can exceed the 4096 default.
      maxTokens: 8192,
    }) as TriageResult;

    // Any successful LLM round-trip proves credits are flowing again.
    clearCreditsBackoff();

    let status: InboundEmailStatus;
    if (triage.kind === profile.dataKind) {
      const data = (triage as { kind: string; data: unknown }).data;
      let applyResult: InboundEmailApplyResult;
      try {
        applyResult = await profile.applyData({
          orgId: email.organizationId,
          emailId,
          data,
        });
      } catch (applyErr) {
        // Apply failure keeps the row re-runnable: 'failed' + reason, and
        // the reaper re-picks it after the retry window. applyData's
        // idempotency contract makes the re-run safe.
        const reason = `applyData failed: ${
          applyErr instanceof Error ? applyErr.message : String(applyErr)
        }`.slice(0, 500);
        if (isTransientDbError(applyErr)) {
          log.warn(
            "inbound-email extract: applyData failed (transient)",
            { source: LOG_SOURCE, emailId },
            applyErr,
          );
        } else {
          log.error(
            "inbound-email extract: applyData failed",
            { source: LOG_SOURCE, emailId },
            applyErr,
          );
        }
        await setTerminalStatus(emailId, "failed", reason);
        return "failed";
      }
      status = "extracted";
      await setTerminalStatus(
        emailId,
        status,
        applyResult.summary?.slice(0, 500) ?? null,
        applyResult,
      );
    } else if (triage.kind === "human_message") {
      status = "human_message";
      const t = triage as Extract<TriageResult, { kind: "human_message" }>;
      await setTerminalStatus(emailId, status, t.summary.slice(0, 500) || null);
    } else {
      status = "unclear";
      const t = triage as Extract<TriageResult, { kind: "unclear" }>;
      await setTerminalStatus(emailId, status, t.reason.slice(0, 500) || null);
    }

    log.info("inbound-email extract: processed", {
      source: LOG_SOURCE,
      emailId,
      status,
      kind: triage.kind,
      organizationId: email.organizationId ?? undefined,
    });
    return status;
  } catch (err) {
    const reason = (err instanceof Error ? err.message : String(err)).slice(0, 500);

    if (err instanceof LlmCreditsExhaustedError) {
      // Entitlement condition, not a code bug: enter the global backoff so
      // the drain stops thrashing until credits are topped up (or the
      // window elapses). The row still lands at 'failed' for a later
      // re-pick.
      enterCreditsBackoff();
      log.warn("inbound-email extract: tenant LLM credits exhausted -- backing off", {
        source: LOG_SOURCE,
        emailId,
        backoffMs: CREDITS_EXHAUSTED_BACKOFF_MS,
      });
    } else if (isTransientLlmError(err) || isTransientDbError(err) || err instanceof TypeError) {
      // Transient external condition (proxy 5xx/throttle, DB blip, fetch
      // network error) -- self-heals via the reaper retry. warn, not error.
      log.warn(
        "inbound-email extract: extraction failed (transient)",
        { source: LOG_SOURCE, emailId, organizationId: email.organizationId ?? undefined },
        err,
      );
    } else {
      // Genuine anomaly (schema-contract break, code bug, unparseable
      // body) -- stays loud.
      log.error(
        "inbound-email extract: extraction failed",
        { source: LOG_SOURCE, emailId, organizationId: email.organizationId ?? undefined },
        err,
      );
    }

    try {
      await setTerminalStatus(emailId, "failed", reason);
    } catch (statusErr) {
      // Even the terminal UPDATE failed (DB outage). The row stays
      // 'received' / stale-'failed' and the next drain re-picks it.
      log.warn(
        "inbound-email extract: failed to set terminal status",
        { source: LOG_SOURCE, emailId },
        statusErr,
      );
    }
    return "failed";
  }
}

// ── Batch drain ──────────────────────────────────────────────────────────────

export interface ProcessBatchOptions {
  /** Max rows to claim + process per call. Default 5; clamped 1..50. */
  batchSize?: number;
  /** A `failed` row is re-pickable once processed_at is older than this. Default 30 min. */
  retryAfterMs?: number;
}

export interface ProcessBatchResult {
  claimed: number;
  processed: number;
  /** Set when the drain skipped without claiming anything. */
  skipped?: "no-profile" | "credits-backoff";
}

/** Default reaper batch size -- small, so a slow LLM call can't stall a pod. */
export const DEFAULT_BATCH_SIZE = 5;
/** Default re-pick threshold for stuck `failed` rows. */
export const DEFAULT_RETRY_AFTER_MS = 30 * 60 * 1000; // 30 min

/** Throttle for the dormant-mode info line: once per 6h per process. */
const NO_PROFILE_LOG_INTERVAL_MS = 6 * 60 * 60 * 1000;
let lastNoProfileLogAt = 0;

function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

/**
 * Claim + process a batch of pending inbound emails:
 *   - status='received' (never processed), OR
 *   - status='failed' whose processed_at is null or older than
 *     `retryAfterMs` (a stuck row a transient failure left behind).
 * Oldest first. Each row is processed sequentially with a per-row
 * backstop so one bad row can't kill the batch.
 *
 * With NO profile registered: returns `{ skipped: "no-profile" }` and the
 * rows stay 'received' untouched (logged at info, throttled to once per
 * 6h per process -- dormancy is by design, not an anomaly).
 *
 * Multi-pod note: extraction idempotency is the profile's contract, so
 * even if two pods claim the same `received` row the domain data stays
 * single-rowed. The reaper adds an advisory lock per tick to avoid the
 * duplicate LLM spend.
 */
export async function processInboundEmailBatch(
  deps: InboundEmailExtractionDeps = {},
  opts: ProcessBatchOptions = {},
): Promise<ProcessBatchResult> {
  if (!getInboundEmailExtractionProfile()) {
    const now = Date.now();
    if (now - lastNoProfileLogAt > NO_PROFILE_LOG_INTERVAL_MS) {
      lastNoProfileLogAt = now;
      log.info(
        "inbound-email extract: no extraction profile registered -- drain dormant",
        { source: LOG_SOURCE, feature: "batch" },
      );
    }
    return { claimed: 0, processed: 0, skipped: "no-profile" };
  }

  if (Date.now() < creditsBackoffUntil) {
    if (!creditsBackoffLogged) {
      creditsBackoffLogged = true;
      log.warn("inbound-email extract: drain paused (LLM credits exhausted backoff)", {
        source: LOG_SOURCE,
        feature: "batch",
        resumesAt: new Date(creditsBackoffUntil).toISOString(),
      });
    }
    return { claimed: 0, processed: 0, skipped: "credits-backoff" };
  }

  const batchSize = clampInt(opts.batchSize, DEFAULT_BATCH_SIZE, 1, 50);
  const retryAfterMs = opts.retryAfterMs ?? DEFAULT_RETRY_AFTER_MS;
  const cutoff = new Date(Date.now() - retryAfterMs);

  const rows = await db
    .selectFrom("inbound_email")
    .select("id")
    .where((eb) =>
      eb.or([
        eb("status", "=", "received"),
        eb.and([
          eb("status", "=", "failed"),
          eb.or([
            eb("processedAt", "is", null),
            eb("processedAt", "<", cutoff),
          ]),
        ]),
      ])
    )
    .orderBy("receivedAt", "asc")
    .limit(batchSize)
    .execute();

  let processed = 0;
  for (const r of rows) {
    try {
      await extractInboundEmail(r.id, deps);
      processed++;
    } catch (err) {
      // extractInboundEmail catches internally, so this is a belt-and-
      // braces backstop -- never let one row kill the drain.
      log.warn(
        "inbound-email extract: batch row failed",
        { source: LOG_SOURCE, emailId: r.id },
        err,
      );
    }
  }
  return { claimed: rows.length, processed };
}
