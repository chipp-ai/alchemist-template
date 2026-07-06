/**
 * Service tests for inbound-email capture: the dedup-key ladder, the
 * attachment allowlist / size-cap / storage-unconfigured sentinel paths,
 * and the uploaded-attachment relative-key shape.
 *
 * Storage is stubbed via the injectable `uploader` + `storageConfigured`
 * seams so outcomes are deterministic whether or not the environment has
 * R2 creds (CI does not).
 *
 * NOTE: rows are captured with organization_id NULL, so they are deleted
 * explicitly in finally blocks (org-cascade cleanup does not cover them).
 */

import { assertEquals, assertExists } from "@std/assert";
import { Buffer } from "node:buffer";
import { db } from "@/db/client.ts";
import "../helpers.ts"; // provisions the per-worker test schema
import {
  ATTACHMENT_MAX_BYTES,
  captureInboundEmail,
  resolveEffectiveContentType,
  resolveMessageId,
  type Uploader,
} from "@/services/inbound-email/capture.service.ts";

function toB64(s: string): string {
  return Buffer.from(s, "utf8").toString("base64");
}

/** Stub uploader that records calls and never hits the network. */
function stubUploader(): {
  calls: { key: string; contentType: string; size: number }[];
  upload: Uploader;
} {
  const calls: { key: string; contentType: string; size: number }[] = [];
  const upload: Uploader = (opts) => {
    calls.push({ key: opts.key, contentType: opts.contentType, size: opts.body.length });
    return Promise.resolve({
      key: opts.key,
      fullKey: `test-prefix/${opts.key}`,
      bucket: "test-bucket",
      url: `s3://test-bucket/test-prefix/${opts.key}`,
    });
  };
  return { calls, upload };
}

async function deleteEmail(id: string | null): Promise<void> {
  if (!id) return;
  await db.deleteFrom("inbound_email").where("id", "=", id).execute();
}

// ── Dedup ladder (pure) ──────────────────────────────────────────────────────

Deno.test({
  name: "capture: dedup ladder -- explicit Message-ID header wins",
  sanitizeResources: false,
  sanitizeOps: false,
  fn() {
    const id = resolveMessageId({
      MessageID: "postmark-guid-123",
      Headers: [
        { Name: "X-Other", Value: "nope" },
        { Name: "Message-ID", Value: " <rfc-id@example.test> " },
      ],
      From: "a@b.c",
    });
    assertEquals(id, "<rfc-id@example.test>");
  },
});

Deno.test({
  name: "capture: dedup ladder -- postmark MessageID fallback",
  sanitizeResources: false,
  sanitizeOps: false,
  fn() {
    // No Message-ID header (empty header value must not count either).
    const id = resolveMessageId({
      MessageID: "postmark-guid-123",
      Headers: [{ Name: "Message-ID", Value: "  " }],
    });
    assertEquals(id, "postmark:postmark-guid-123");
  },
});

Deno.test({
  name: "capture: dedup ladder -- synthetic hash last resort, deterministic",
  sanitizeResources: false,
  sanitizeOps: false,
  fn() {
    const payload = { From: "a@b.c", Subject: "s", TextBody: "body" };
    const id1 = resolveMessageId(payload);
    const id2 = resolveMessageId({ ...payload });
    assertEquals(id1.startsWith("synthetic:"), true);
    // Deterministic: identical payloads dedup against each other.
    assertEquals(id1, id2);
    // Different content -> different key.
    const id3 = resolveMessageId({ ...payload, TextBody: "other body" });
    assertEquals(id3.startsWith("synthetic:"), true);
    assertEquals(id1 === id3, false);
  },
});

// ── Effective MIME resolution (pure) ─────────────────────────────────────────

Deno.test({
  name: "capture: generic declared type resolves via magic bytes then extension",
  sanitizeResources: false,
  sanitizeOps: false,
  fn() {
    const pdfBytes = new TextEncoder().encode("%PDF-1.4 fake");
    // octet-stream + PDF magic -> pdf
    assertEquals(
      resolveEffectiveContentType("application/octet-stream", "doc.bin", pdfBytes),
      "application/pdf",
    );
    // octet-stream + no magic + .xlsx extension -> xlsx
    assertEquals(
      resolveEffectiveContentType("application/octet-stream", "sheet.xlsx", new Uint8Array([1, 2])),
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    // A SPECIFIC declared type is trusted as-is (params stripped).
    assertEquals(
      resolveEffectiveContentType("text/csv; charset=utf-8", "x.csv", new Uint8Array()),
      "text/csv",
    );
    // Generic + no signal stays generic (and will fail the allowlist).
    assertEquals(
      resolveEffectiveContentType("application/octet-stream", "mystery.bin", new Uint8Array([1])),
      "application/octet-stream",
    );
  },
});

// ── Capture paths (DB) ───────────────────────────────────────────────────────

Deno.test({
  name: "capture: disallowed attachment type recorded with '' sentinel, never uploaded",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const { calls, upload } = stubUploader();
    let emailId: string | null = null;
    try {
      const result = await captureInboundEmail({
        Subject: "zip attachment",
        TextBody: `capture-disallowed ${crypto.randomUUID()}`,
        Attachments: [
          {
            Name: "archive.zip",
            Content: toB64("PK fake zip bytes"),
            ContentType: "application/zip",
          },
        ],
      }, { uploader: upload, storageConfigured: true });

      emailId = result.id;
      assertExists(emailId);
      assertEquals(result.deduplicated, false);
      assertEquals(result.attachmentCount, 1);
      assertEquals(result.uploaded, 0);
      assertEquals(result.skipped, 1);
      // The uploader must never have been called for a disallowed type.
      assertEquals(calls.length, 0);

      const att = await db
        .selectFrom("inbound_email_attachment")
        .select(["filename", "r2Key", "sha256", "sizeBytes"])
        .where("inboundEmailId", "=", emailId!)
        .executeTakeFirst();
      assertExists(att);
      assertEquals(att!.r2Key, ""); // recorded-not-stored sentinel
      assertEquals(att!.filename, "archive.zip");
      assertExists(att!.sha256); // hash still recorded for forensics

      // The skip reason rolls into the email's status_reason.
      const email = await db
        .selectFrom("inbound_email")
        .select(["statusReason", "attachmentCount", "status"])
        .where("id", "=", emailId!)
        .executeTakeFirstOrThrow();
      assertEquals(email.status, "received");
      assertEquals(email.attachmentCount, 1);
      assertEquals(email.statusReason?.includes("disallowed content_type"), true);
    } finally {
      await deleteEmail(emailId);
    }
  },
});

Deno.test({
  name: "capture: oversized attachment recorded-not-stored",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const { calls, upload } = stubUploader();
    let emailId: string | null = null;
    try {
      // Allowed type (text/plain) but one byte over the cap.
      const big = Buffer.alloc(ATTACHMENT_MAX_BYTES + 1, 0x61).toString("base64");
      const result = await captureInboundEmail({
        Subject: "oversized attachment",
        TextBody: `capture-oversized ${crypto.randomUUID()}`,
        Attachments: [
          { Name: "big.txt", Content: big, ContentType: "text/plain" },
        ],
      }, { uploader: upload, storageConfigured: true });

      emailId = result.id;
      assertExists(emailId);
      assertEquals(result.uploaded, 0);
      assertEquals(result.skipped, 1);
      assertEquals(calls.length, 0);

      const att = await db
        .selectFrom("inbound_email_attachment")
        .select(["r2Key", "sizeBytes"])
        .where("inboundEmailId", "=", emailId!)
        .executeTakeFirstOrThrow();
      assertEquals(att.r2Key, "");
      assertEquals(att.sizeBytes, ATTACHMENT_MAX_BYTES + 1);

      const email = await db
        .selectFrom("inbound_email")
        .select("statusReason")
        .where("id", "=", emailId!)
        .executeTakeFirstOrThrow();
      assertEquals(email.statusReason?.includes("oversized"), true);
    } finally {
      await deleteEmail(emailId);
    }
  },
});

Deno.test({
  name: "capture: storage unconfigured -> allowed attachment recorded with sentinel",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const { calls, upload } = stubUploader();
    let emailId: string | null = null;
    try {
      const result = await captureInboundEmail({
        Subject: "no storage",
        TextBody: `capture-nostorage ${crypto.randomUUID()}`,
        Attachments: [
          { Name: "report.csv", Content: toB64("a,b\n1,2"), ContentType: "text/csv" },
        ],
      }, { uploader: upload, storageConfigured: false });

      emailId = result.id;
      assertExists(emailId);
      assertEquals(result.uploaded, 0);
      assertEquals(result.skipped, 1);
      assertEquals(calls.length, 0); // never uploads when storage is off

      const att = await db
        .selectFrom("inbound_email_attachment")
        .select("r2Key")
        .where("inboundEmailId", "=", emailId!)
        .executeTakeFirstOrThrow();
      assertEquals(att.r2Key, "");

      const email = await db
        .selectFrom("inbound_email")
        .select("statusReason")
        .where("id", "=", emailId!)
        .executeTakeFirstOrThrow();
      assertEquals(email.statusReason?.includes("storage not configured"), true);
    } finally {
      await deleteEmail(emailId);
    }
  },
});

Deno.test({
  name: "capture: allowed attachment uploads with hashed-folder relative key",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const { calls, upload } = stubUploader();
    let emailId: string | null = null;
    try {
      const result = await captureInboundEmail({
        Subject: "stored attachment",
        TextBody: `capture-stored ${crypto.randomUUID()}`,
        MessageID: crypto.randomUUID(),
        Attachments: [
          { Name: "data file.csv", Content: toB64("a,b\n1,2"), ContentType: "text/csv" },
        ],
      }, { uploader: upload, storageConfigured: true });

      emailId = result.id;
      assertExists(emailId);
      assertEquals(result.uploaded, 1);
      assertEquals(result.skipped, 0);
      assertEquals(calls.length, 1);
      // Relative key: inbound-email/<64-hex message-id hash>/<idx>-<sanitized name>
      assertEquals(
        /^inbound-email\/[0-9a-f]{64}\/0-data_file\.csv$/.test(calls[0].key),
        true,
        `unexpected key shape: ${calls[0].key}`,
      );

      // The DB stores the RELATIVE key, not the prefixed fullKey.
      const att = await db
        .selectFrom("inbound_email_attachment")
        .select(["r2Key", "contentType"])
        .where("inboundEmailId", "=", emailId!)
        .executeTakeFirstOrThrow();
      assertEquals(att.r2Key, calls[0].key);
      assertEquals(att.r2Key.startsWith("test-prefix/"), false);
      assertEquals(att.contentType, "text/csv");
    } finally {
      await deleteEmail(emailId);
    }
  },
});
