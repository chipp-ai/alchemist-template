/**
 * Accepted-upload allowlist -- the fail-closed contract.
 *
 * The point of this module is that an agent ticket asking for "let people
 * attach a receipt" never has to decide what a safe file is. So the tests
 * below pin the DECISIONS, not the implementation:
 *
 *   - the default set is exactly pdf/jpeg/png/doc/docx/csv/xlsx
 *   - extension AND content type are both checked, and must agree
 *   - `allow` narrows and can never widen
 *   - the size cap is a ceiling a caller cannot raise
 *   - the client mirror carries the same table
 */

import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  acceptAttribute,
  assertAllowedUpload,
  checkUpload,
  describeUploadPolicy,
  extensionOf,
  MAX_UPLOAD_BYTES,
  normalizeContentType,
  UPLOAD_TYPE_IDS,
  UPLOAD_TYPES,
  type UploadTypeId,
} from "@/utils/upload-types.ts";

function ok(filename: string, contentType: string, sizeBytes = 1024) {
  const result = checkUpload({ filename, contentType, sizeBytes });
  assert(
    result.ok,
    `expected ${filename} / ${contentType} to pass, got: ${JSON.stringify(result)}`,
  );
  return result;
}

function rejected(filename: string, contentType: string, sizeBytes?: number) {
  const result = checkUpload({ filename, contentType, sizeBytes });
  assert(!result.ok, `expected ${filename} / ${contentType} to be rejected`);
  return result;
}

// ── The table itself ───────────────────────────────────────────────────────

Deno.test("allowlist: the default set is the seven documented types", () => {
  assertEquals(
    [...UPLOAD_TYPE_IDS],
    ["pdf", "jpeg", "png", "doc", "docx", "csv", "xlsx"],
  );
});

Deno.test("allowlist: every id maps to a spec that agrees with its key", () => {
  for (const id of UPLOAD_TYPE_IDS) {
    const spec = UPLOAD_TYPES[id];
    assertEquals(spec.id, id);
    assert(spec.extensions.length > 0, `${id} has no extensions`);
    assert(spec.contentTypes.length > 0, `${id} has no content types`);
    for (const ext of spec.extensions) {
      assert(ext.startsWith("."), `${id}: extension ${ext} must be dot-prefixed`);
      assertEquals(ext, ext.toLowerCase(), `${id}: extension ${ext} must be lowercase`);
    }
    for (const ct of spec.contentTypes) {
      assertEquals(ct, ct.toLowerCase(), `${id}: content type ${ct} must be lowercase`);
    }
  }
});

Deno.test("allowlist: no extension is claimed by two types", () => {
  const seen = new Map<string, UploadTypeId>();
  for (const id of UPLOAD_TYPE_IDS) {
    for (const ext of UPLOAD_TYPES[id].extensions) {
      const prior = seen.get(ext);
      assertEquals(prior, undefined, `${ext} is claimed by both ${prior} and ${id}`);
      seen.set(ext, id);
    }
  }
});

// ── Happy paths ────────────────────────────────────────────────────────────

Deno.test("check: accepts one file of each documented type", () => {
  ok("report.pdf", "application/pdf");
  ok("photo.jpg", "image/jpeg");
  ok("photo.jpeg", "image/jpeg");
  ok("logo.png", "image/png");
  ok("memo.doc", "application/msword");
  ok(
    "memo.docx",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  );
  ok("rows.csv", "text/csv");
  ok(
    "book.xlsx",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  );
});

Deno.test("check: uppercase extensions and content types still pass", () => {
  const result = ok("SCAN.PDF", "Application/PDF");
  assertEquals(result.extension, ".pdf");
  assertEquals(result.contentType, "application/pdf");
});

Deno.test("check: a charset parameter on the content type is ignored", () => {
  const result = ok("rows.csv", "text/csv; charset=utf-8");
  assertEquals(result.contentType, "text/csv");
});

// ── Rejections ─────────────────────────────────────────────────────────────

Deno.test("check: rejects an extension that is not on the list", () => {
  assertEquals(rejected("payload.exe", "application/pdf").code, "extension_not_allowed");
});

Deno.test("check: rejects a file with no extension at all", () => {
  assertEquals(rejected("README", "application/pdf").code, "extension_not_allowed");
});

Deno.test("check: rejects a content type that is not on the list", () => {
  assertEquals(rejected("page.pdf", "text/html").code, "content_type_not_allowed");
});

Deno.test("check: rejects a missing content type", () => {
  assertEquals(rejected("page.pdf", "").code, "missing_content_type");
});

Deno.test("check: rejects a missing filename", () => {
  assertEquals(rejected("   ", "application/pdf").code, "missing_filename");
});

Deno.test("check: rejects an allowed extension wearing another type's content type", () => {
  // The classic smuggle: name it .png, declare it a PDF (or the reverse).
  // Both labels are individually on the list; they disagree, so it fails.
  assertEquals(rejected("logo.png", "application/pdf").code, "type_mismatch");
  assertEquals(rejected("report.pdf", "image/png").code, "type_mismatch");
});

Deno.test("check: a double extension is judged on the LAST one", () => {
  // `invoice.pdf.exe` is an exe. The extension parser must not stop at
  // the first dot.
  assertEquals(rejected("invoice.pdf.exe", "application/pdf").code, "extension_not_allowed");
});

Deno.test("check: a path-shaped filename is judged on its basename", () => {
  assertEquals(rejected("report.pdf/evil", "application/pdf").code, "extension_not_allowed");
});

Deno.test("check: rejects an empty file", () => {
  assertEquals(rejected("report.pdf", "application/pdf", 0).code, "empty");
});

Deno.test("check: rejects a file over the cap", () => {
  assertEquals(
    rejected("report.pdf", "application/pdf", MAX_UPLOAD_BYTES + 1).code,
    "too_large",
  );
});

Deno.test("check: accepts a file exactly at the cap", () => {
  ok("report.pdf", "application/pdf", MAX_UPLOAD_BYTES);
});

Deno.test("check: an unknown size is not a rejection", () => {
  // Presigned-URL requests know the type but not the byte count yet.
  const result = checkUpload({ filename: "report.pdf", contentType: "application/pdf" });
  assert(result.ok);
});

// ── Narrowing ──────────────────────────────────────────────────────────────

Deno.test("allow: narrows the accepted set for this call", () => {
  const opts = { allow: ["pdf", "png"] as const };
  assert(checkUpload({ filename: "a.pdf", contentType: "application/pdf" }, opts).ok);
  const denied = checkUpload({ filename: "a.csv", contentType: "text/csv" }, opts);
  assert(!denied.ok);
  assertEquals(denied.code, "extension_not_allowed");
});

Deno.test("allow: cannot widen past the table", () => {
  // An unknown id is dropped rather than honoured, so a caller cannot
  // invent a type by passing it here.
  const opts = { allow: ["zip" as UploadTypeId] };
  const denied = checkUpload({ filename: "a.zip", contentType: "application/zip" }, opts);
  assert(!denied.ok);
});

Deno.test("maxBytes: a caller may lower the cap but never raise it", () => {
  const lowered = checkUpload(
    { filename: "a.pdf", contentType: "application/pdf", sizeBytes: 5000 },
    { maxBytes: 1000 },
  );
  assert(!lowered.ok);
  assertEquals(lowered.code, "too_large");

  const raised = checkUpload(
    { filename: "a.pdf", contentType: "application/pdf", sizeBytes: MAX_UPLOAD_BYTES + 1 },
    { maxBytes: MAX_UPLOAD_BYTES * 10 },
  );
  assert(!raised.ok);
  assertEquals(raised.code, "too_large");
});

// ── Throwing wrapper ───────────────────────────────────────────────────────

Deno.test("assertAllowedUpload: a rejection is a 400, not a 500", () => {
  const err = assertThrows(
    () => assertAllowedUpload({ filename: "x.exe", contentType: "application/pdf" }),
    Error,
  ) as Error & { statusCode?: number };
  assertEquals(err.statusCode, 400);
});

Deno.test("assertAllowedUpload: returns the resolved type on success", () => {
  const resolved = assertAllowedUpload({
    filename: "Scan 2026.PDF",
    contentType: "application/pdf",
    sizeBytes: 10,
  });
  assertEquals(resolved.type.id, "pdf");
  assertEquals(resolved.extension, ".pdf");
});

// ── Helpers ────────────────────────────────────────────────────────────────

Deno.test("extensionOf: handles the shapes a browser actually sends", () => {
  assertEquals(extensionOf("a.pdf"), ".pdf");
  assertEquals(extensionOf("A.PDF"), ".pdf");
  assertEquals(extensionOf("no-extension"), "");
  assertEquals(extensionOf("trailing."), "");
  assertEquals(extensionOf(".hidden"), "");
  assertEquals(extensionOf("C:\\Users\\me\\book.xlsx"), ".xlsx");
});

Deno.test("normalizeContentType: strips parameters and lowercases", () => {
  assertEquals(normalizeContentType("Text/CSV; charset=UTF-8"), "text/csv");
});

Deno.test("acceptAttribute: lists extensions and MIME types, no duplicates", () => {
  const accept = acceptAttribute(["pdf"]);
  assertEquals(accept, ".pdf,application/pdf");
  const parts = acceptAttribute().split(",");
  assertEquals(parts.length, new Set(parts).size, "accept attribute has duplicates");
});

Deno.test("describeUploadPolicy: is what the API hands the browser", () => {
  const policy = describeUploadPolicy();
  assertEquals(policy.maxBytes, MAX_UPLOAD_BYTES);
  assertEquals(policy.types.length, UPLOAD_TYPE_IDS.length);
  assertEquals(policy.types[0].id, "pdf");

  const narrowed = describeUploadPolicy({ allow: ["csv"] });
  assertEquals(narrowed.types.length, 1);
  assertEquals(narrowed.accept.includes(".csv"), true);
});

// ── Client mirror lint ─────────────────────────────────────────────────────

Deno.test("client mirror: web/src/lib/upload-types.ts carries the same table", async () => {
  // Same discipline as lib/roles.ts <-> web/src/lib/permissions.ts. If the
  // two tables drift, the picker offers a file the server then refuses,
  // which reads to a user as a broken upload button.
  const mirror = await Deno.readTextFile(
    new URL("../../../web/src/lib/upload-types.ts", import.meta.url),
  );

  for (const id of UPLOAD_TYPE_IDS) {
    const spec = UPLOAD_TYPES[id];
    assert(
      mirror.includes(`"${id}"`),
      `Server type "${id}" is missing from the client mirror.`,
    );
    for (const ext of spec.extensions) {
      assert(
        mirror.includes(`"${ext}"`),
        `Server extension "${ext}" (${id}) is missing from the client mirror.`,
      );
    }
    for (const ct of spec.contentTypes) {
      assert(
        mirror.includes(`"${ct}"`),
        `Server content type "${ct}" (${id}) is missing from the client mirror.`,
      );
    }
  }

  assert(
    mirror.includes("MAX_UPLOAD_BYTES = 20 * 1024 * 1024"),
    "The client mirror's size cap drifted from MAX_UPLOAD_BYTES.",
  );
  assertEquals(MAX_UPLOAD_BYTES, 20 * 1024 * 1024);
});

Deno.test("client mirror: declares no type the server does not", async () => {
  const mirror = await Deno.readTextFile(
    new URL("../../../web/src/lib/upload-types.ts", import.meta.url),
  );
  // The mirror's id list is a literal tuple; pull it back out and compare.
  const match = mirror.match(/export const UPLOAD_TYPE_IDS = \[([\s\S]*?)\] as const;/);
  assert(match, "Could not find UPLOAD_TYPE_IDS in the client mirror.");
  const ids = [...match[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  assertEquals(ids, [...UPLOAD_TYPE_IDS]);
});
