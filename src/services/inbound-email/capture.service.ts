/**
 * Inbound-email capture service -- Stage 1 of the capture-first pipeline.
 * Ported from the Valor Victoria customer repo
 * (src/services/vv/inbound-email/capture.service.ts) and genericized.
 *
 * Persists a forwarded email + its attachments durably and auditably,
 * BEFORE any extraction runs (extraction is a re-runnable projection in
 * src/services/inbound-email/extract.service.ts).
 *
 * Invariants:
 *   - SYNCHRONOUS + IDEMPOTENT. Dedup on the resolved message id (RFC
 *     `Message-ID` header > Postmark MessageID > synthetic hash). A
 *     Postmark re-delivery, or a double-forward carrying the same RFC id,
 *     is a no-op with NO side effects -- it acks but does not re-upload or
 *     re-insert.
 *   - CAPTURE NEVER FAILS ON EXTRACTION. Rows land at status='received'.
 *     A genuine storage/DB outage DOES propagate (so the route returns
 *     5xx and Postmark retries) -- that is what preserves durability, and
 *     the message-id dedup makes the retry safe.
 *   - TENANT RESOLVED SERVER-SIDE via resolveIngestOrgId() (the
 *     `INGEST_ORG_ID` env var, read lazily); never from a body field.
 *     Unset/invalid => capture proceeds with organization_id NULL.
 *   - BOUNDED. Disallowed / oversized attachments -- and ALL attachments
 *     when storage is unconfigured -- are RECORDED as rows (r2_key='' +
 *     a note rolled into inbound_email.status_reason), never silently
 *     dropped and never a hard failure.
 *
 * Storage keys are RELATIVE (`inbound-email/<message-id-hash>/<index>-
 * <filename>`); storage.service.ts prepends the tenant prefix. The
 * relative key is what gets stored in the DB.
 *
 * SECURITY -- why the folder segment is a HASH, not the sanitized id:
 * the Message-ID and attachment filenames are FULLY attacker-controlled
 * (any email reaching the inbound address is forwarded by Postmark into
 * this webhook; the bearer token only authenticates Postmark, not the
 * original sender). A lossy `sanitizeSegment(messageId)` folder would be
 * unsafe: many characters collapse to "_", so two DISTINCT raw
 * Message-IDs (separate inbound_email rows, since the DB key is the FULL
 * id) could sanitize to the SAME folder -- letting an attacker who knows
 * a legitimate message's id + filenames overwrite that already-archived
 * message's attachment objects. A SHA-256 of the FULL message_id is
 * collision-resistant yet deterministic -- a same-message retry
 * overwrites the identical key with identical bytes (and the DB dedup
 * short-circuits before any upload anyway).
 */

import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { withTimeout } from "@/db/client.ts";
import { log } from "@/lib/logger.ts";
import { isStorageConfigured, putObject } from "@/services/storage.service.ts";

// ── Postmark inbound payload shape ──────────────────────────────────────────
// Only the fields we read are typed; the route's zod schema is
// `.passthrough()` so unknown Postmark fields survive but aren't relied on.

export interface PostmarkHeader {
  Name: string;
  Value: string;
}

export interface PostmarkAttachment {
  Name?: string;
  /** base64-encoded bytes. */
  Content?: string;
  ContentType?: string;
  ContentLength?: number;
  ContentID?: string;
}

export interface PostmarkInboundPayload {
  From?: string;
  To?: string;
  /** The actual inbound address the message hit. */
  OriginalRecipient?: string;
  Subject?: string;
  TextBody?: string;
  HtmlBody?: string;
  /** Postmark's own GUID -- NOT the RFC Message-ID. Stable across Postmark retries. */
  MessageID?: string;
  Headers?: PostmarkHeader[];
  Attachments?: PostmarkAttachment[];
  /** Present only when the Inbound Stream has "Include raw email content" enabled. */
  RawEmail?: string;
  [key: string]: unknown;
}

// ── Capture policy constants ─────────────────────────────────────────────────

/** Per-attachment decoded-size cap. Oversized -> recorded, not stored. */
export const ATTACHMENT_MAX_BYTES = 15 * 1024 * 1024; // 15 MB

/**
 * Content-type allowlist. Disallowed -> recorded, not stored. Matched on
 * the bare MIME type (params like `; charset=utf-8` are stripped).
 */
export const ALLOWED_CONTENT_TYPES = new Set<string>([
  "application/pdf",
  "text/csv",
  "application/csv",
  "application/vnd.ms-excel", // legacy .xls
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", // .xlsx
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/gif",
  "image/webp",
  "image/tiff",
  "text/plain",
]);

/** Injectable uploader seam (defaults to the real putObject) so tests
 * can assert upload calls deterministically without hitting storage. */
export type Uploader = typeof putObject;

export interface CaptureResult {
  /** The inbound_email row id, or null when nothing was written (lost dedup race). */
  id: string | null;
  messageId: string;
  /** True when this message was already captured (no side effects this call). */
  deduplicated: boolean;
  /** Total attachment rows recorded (stored + skipped). */
  attachmentCount: number;
  /** Attachments uploaded to storage. */
  uploaded: number;
  /** Attachments recorded-but-not-stored (disallowed / oversized / no storage). */
  skipped: number;
}

// ── Tenant resolution ─────────────────────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Warn only once per process about an invalid INGEST_ORG_ID value. */
let warnedInvalidIngestOrgId = false;

/**
 * Resolve the org captured emails are attributed to: the `INGEST_ORG_ID`
 * env var, read LAZILY per capture (never at module load). Returns null
 * when unset or not UUID-shaped -- capture still proceeds (the column is
 * nullable by design), the row is just invisible to the org-scoped
 * dashboard API.
 */
export function resolveIngestOrgId(): string | null {
  let raw = "";
  try {
    raw = (Deno.env.get("INGEST_ORG_ID") ?? "").trim();
  } catch {
    return null;
  }
  if (!raw) return null;
  if (!UUID_RE.test(raw)) {
    if (!warnedInvalidIngestOrgId) {
      warnedInvalidIngestOrgId = true;
      log.warn("INGEST_ORG_ID is not a valid UUID; capturing with organization_id NULL", {
        source: "inbound-email",
        feature: "capture",
      });
    }
    return null;
  }
  return raw;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Normalize a content type to its bare MIME (drop `; charset=...` params,
 * lowercase, trim). Empty string when absent.
 */
function bareContentType(ct: string | undefined): string {
  return (ct ?? "").split(";")[0].trim().toLowerCase();
}

/**
 * Generic binary placeholders. Mail clients and MTAs routinely send a real
 * PDF/xlsx labeled as one of these instead of its true MIME -- so we must
 * NOT reject on the declared type alone; we sniff instead.
 */
const GENERIC_CONTENT_TYPES = new Set<string>([
  "",
  "application/octet-stream",
  "binary/octet-stream",
  "application/binary",
  "application/download",
  "application/force-download",
]);

/** Filename-extension -> MIME fallback (used when the declared type is generic). */
const EXTENSION_CONTENT_TYPES: Record<string, string> = {
  pdf: "application/pdf",
  csv: "text/csv",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  tif: "image/tiff",
  tiff: "image/tiff",
  txt: "text/plain",
};

/** Sniff an UNAMBIGUOUS type from leading magic bytes. Returns null otherwise.
 * (We deliberately don't sniff zip-family `PK\x03\x04` -- could be xlsx/docx/any
 *  zip; xlsx is resolved by extension instead.) */
function sniffMagicBytes(b: Uint8Array): string | null {
  if (b.length >= 4 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) {
    return "application/pdf"; // "%PDF"
  }
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    return "image/png";
  }
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    return "image/jpeg";
  }
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) {
    return "image/gif"; // "GIF8"
  }
  return null;
}

function extensionOf(filename: string | null): string {
  if (!filename) return "";
  const m = filename.toLowerCase().match(/\.([a-z0-9]+)\s*$/);
  return m ? m[1] : "";
}

/**
 * Resolve the EFFECTIVE MIME for an attachment. A specific declared type is
 * trusted as-is; a GENERIC placeholder (octet-stream, etc.) is resolved by
 * magic bytes first (authoritative) then filename extension. Anything that
 * still can't be identified keeps its (generic) declared type and is rejected
 * by the allowlist -- a renamed binary with no PDF/image signature does NOT
 * slip through.
 */
export function resolveEffectiveContentType(
  rawCt: string | null | undefined,
  filename: string | null,
  bytes: Uint8Array,
): string {
  const declared = bareContentType(rawCt ?? undefined);
  if (!GENERIC_CONTENT_TYPES.has(declared)) return declared;
  const magic = sniffMagicBytes(bytes);
  if (magic) return magic;
  return EXTENSION_CONTENT_TYPES[extensionOf(filename)] ?? declared;
}

/**
 * Sanitize a string into a single safe storage path segment that survives
 * `scopedKey()`'s checks (no empty / "." / ".." / "/" / "\" segments,
 * no leading slash). Replaces anything outside a conservative allowlist
 * with "_", strips leading dots, caps length, and falls back when empty.
 */
export function sanitizeSegment(input: string | undefined, fallback: string): string {
  const raw = (input ?? "").trim();
  let s = raw.replace(/[^A-Za-z0-9._@+-]/g, "_");
  // Strip leading dots so the segment can never be "." / ".." / a
  // dot-collapsed invalid segment.
  s = s.replace(/^\.+/, "");
  // Cap length -- storage keys are capped at 900 chars total by scopedKey;
  // keep each segment well under that.
  if (s.length > 180) s = s.slice(0, 180);
  return s.length > 0 ? s : fallback;
}

/**
 * Resolve the dedup key. Prefer the RFC `Message-ID` header (stable across
 * a re-forward that creates a NEW Postmark message), then fall back to
 * Postmark's own MessageID (stable across Postmark's own retries), then a
 * deterministic synthesized id (the column is NOT NULL -- we must always
 * produce one). Forwarding/Postmark can double-send, so a stable key is
 * the whole point.
 */
export function resolveMessageId(payload: PostmarkInboundPayload): string {
  const headers = Array.isArray(payload.Headers) ? payload.Headers : [];
  for (const h of headers) {
    if (h && typeof h.Name === "string" && h.Name.toLowerCase() === "message-id") {
      const v = (h.Value ?? "").trim();
      if (v.length > 0) return v;
    }
  }
  const pm = (payload.MessageID ?? "").trim();
  if (pm.length > 0) return `postmark:${pm}`;
  // Last resort: hash the stable-ish fields so a retry of a no-id message
  // still dedups against itself.
  const basis = JSON.stringify({
    f: payload.From ?? "",
    t: payload.OriginalRecipient ?? payload.To ?? "",
    s: payload.Subject ?? "",
    b: payload.TextBody ?? payload.HtmlBody ?? "",
  });
  const hash = createHash("sha256").update(basis).digest("hex").slice(0, 32);
  return `synthetic:${hash}`;
}

interface ProcessedAttachment {
  filename: string | null;
  contentType: string | null;
  sizeBytes: number;
  sha256: string;
  r2Key: string; // "" when recorded-but-not-stored
}

// ── Main entry point ──────────────────────────────────────────────────────────

/**
 * Capture one Postmark inbound email. Idempotent on the resolved message id.
 * See file header for the full invariant set.
 *
 * `opts.uploader` / `opts.storageConfigured` are test seams; production
 * callers pass nothing.
 */
export async function captureInboundEmail(
  payload: PostmarkInboundPayload,
  opts?: { uploader?: Uploader; storageConfigured?: boolean },
): Promise<CaptureResult> {
  const upload = opts?.uploader ?? putObject;
  const storageOk = opts?.storageConfigured ?? isStorageConfigured();
  const messageId = resolveMessageId(payload);

  // 1. Dedup fast-path -- a re-delivery acks with NO side effects (no
  //    re-upload, no re-insert). This is the common Postmark-retry case.
  const existing = await withTimeout(5_000, (trx) =>
    trx
      .selectFrom("inbound_email")
      .select("id")
      .where("messageId", "=", messageId)
      .executeTakeFirst());
  if (existing) {
    return {
      id: existing.id,
      messageId,
      deduplicated: true,
      attachmentCount: 0,
      uploaded: 0,
      skipped: 0,
    };
  }

  // 2. Resolve tenant server-side (nullable -- capture still proceeds when
  //    no org resolves; the column is nullable by design).
  const organizationId = resolveIngestOrgId();

  // Collision-resistant folder segment derived from the FULL message_id
  // (NOT a lossy sanitized form -- see the SECURITY note in the file
  // header). Distinct message_ids can never share a folder.
  const keyMessageSegment = createHash("sha256").update(messageId).digest("hex");
  const skipNotes: string[] = [];
  const processed: ProcessedAttachment[] = [];
  let uploaded = 0;
  let skipped = 0;

  // 3. Process attachments. Uploads happen BEFORE the row insert so a
  //    transient storage failure aborts before any DB row is written -> a
  //    clean Postmark retry. Re-uploads on retry overwrite the same
  //    deterministic key with identical bytes.
  const attachments = Array.isArray(payload.Attachments) ? payload.Attachments : [];
  for (let i = 0; i < attachments.length; i++) {
    const att = attachments[i];
    const bytes = new Uint8Array(Buffer.from(att.Content ?? "", "base64"));
    const sizeBytes = bytes.length;
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const filename = att.Name ?? null;
    const rawCt = att.ContentType ?? null;
    const declaredCt = bareContentType(att.ContentType);
    // Resolve the TRUE type -- a PDF arriving as application/octet-stream
    // (common from many MTAs) must be stored + typed as a PDF, otherwise
    // it's neither downloadable nor sent to the extraction LLM as a document.
    const ct = resolveEffectiveContentType(rawCt, filename, bytes);

    const typeAllowed = ALLOWED_CONTENT_TYPES.has(ct);
    const sizeOk = sizeBytes <= ATTACHMENT_MAX_BYTES;

    if (typeAllowed && sizeOk && storageOk) {
      const relKey = `inbound-email/${keyMessageSegment}/${i}-${
        sanitizeSegment(filename ?? undefined, "attachment")
      }`;
      const res = await upload({ key: relKey, body: bytes, contentType: ct });
      // Store the RELATIVE key (the service prepends the tenant prefix) and
      // the RESOLVED type (not the generic declared one) so download serves
      // the right Content-Type and extract.service treats it as a PDF.
      processed.push({ filename, contentType: ct, sizeBytes, sha256, r2Key: res.key });
      uploaded++;
    } else {
      // Recorded, not stored, not a hard failure.
      const reason = !typeAllowed
        ? `disallowed content_type '${ct || "unknown"}'${
          ct !== declaredCt ? ` (declared '${declaredCt || "unknown"}')` : ""
        }`
        : !sizeOk
        ? `oversized ${sizeBytes} bytes (cap ${ATTACHMENT_MAX_BYTES})`
        : "storage not configured";
      skipNotes.push(`attachment ${i} (${filename ?? "unnamed"}): ${reason}`);
      processed.push({ filename, contentType: rawCt, sizeBytes, sha256, r2Key: "" });
      skipped++;
    }
  }

  // 4. Optional raw MIME blob (only present when the Inbound Stream enables
  //    raw inclusion). Stored best-effort for the most-complete-form
  //    guarantee -- NOT load-bearing for capture.
  let rawMimeKey: string | null = null;
  if (storageOk && typeof payload.RawEmail === "string" && payload.RawEmail.length > 0) {
    try {
      const rawBytes = new Uint8Array(Buffer.from(payload.RawEmail, "utf8"));
      const rawKey = `inbound-email/${keyMessageSegment}/raw-mime.eml`;
      const res = await upload({ key: rawKey, body: rawBytes, contentType: "message/rfc822" });
      rawMimeKey = res.key;
    } catch (err) {
      log.warn(
        "inbound-email: raw MIME upload failed; capturing without raw_mime_key",
        { source: "inbound-email", feature: "capture", messageId },
        err,
      );
    }
  }

  const statusReason = skipNotes.length > 0 ? skipNotes.join("; ").slice(0, 500) : null;

  // 5. Insert the inbound_email row + attachment rows in one transaction.
  //    ON CONFLICT (message_id) DO NOTHING guards against a concurrent
  //    re-delivery that slipped past the fast-path SELECT.
  const writeResult = await withTimeout(10_000, async (trx) => {
    const inserted = await trx
      .insertInto("inbound_email")
      .values({
        organizationId,
        messageId,
        fromAddress: payload.From ?? null,
        toAddress: payload.OriginalRecipient ?? payload.To ?? null,
        subject: payload.Subject ?? null,
        bodyText: payload.TextBody ?? null,
        bodyHtml: payload.HtmlBody ?? null,
        // Pass the array directly -- the postgres.js dialect serializes
        // JSONB params itself (JSON.stringify here double-encodes).
        headers: Array.isArray(payload.Headers) ? payload.Headers : null,
        rawMimeKey,
        attachmentCount: processed.length,
        status: "received",
        statusReason,
      })
      .onConflict((oc) => oc.column("messageId").doNothing())
      .returning("id")
      .executeTakeFirst();

    if (!inserted) {
      // Lost a concurrent race -- the other writer captured this message.
      return { id: null as string | null, deduplicated: true };
    }

    if (processed.length > 0) {
      await trx
        .insertInto("inbound_email_attachment")
        .values(processed.map((p) => ({
          inboundEmailId: inserted.id,
          filename: p.filename,
          contentType: p.contentType,
          sizeBytes: p.sizeBytes,
          sha256: p.sha256,
          r2Key: p.r2Key,
        })))
        .execute();
    }
    return { id: inserted.id, deduplicated: false };
  });

  if (writeResult.deduplicated) {
    return {
      id: writeResult.id,
      messageId,
      deduplicated: true,
      attachmentCount: 0,
      uploaded: 0,
      skipped: 0,
    };
  }

  log.info("inbound-email captured", {
    source: "inbound-email",
    feature: "capture",
    messageId,
    organizationId: organizationId ?? undefined,
    attachmentCount: processed.length,
    uploaded,
    skipped,
  });

  return {
    id: writeResult.id,
    messageId,
    deduplicated: false,
    attachmentCount: processed.length,
    uploaded,
    skipped,
  };
}
