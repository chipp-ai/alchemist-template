/**
 * Uploaded-file service -- storage, the review lifecycle, and who may read.
 *
 * These run against the real database and the real local storage driver,
 * so "the row says 20 bytes" and "20 bytes came back off the disk" are
 * both actually true. No mocks, no network.
 */

import { assert, assertEquals, assertRejects } from "@std/assert";
import { createIsolatedUser, getTestDb, withLocalStorage } from "../helpers.ts";
import {
  approveUploadedFile,
  canDeleteUploadedFile,
  canReadUploadedFile,
  countPendingReview,
  deleteUploadedFile,
  getUploadedFile,
  listPendingReview,
  listUploadedFiles,
  rejectUploadedFile,
  storeUploadedFile,
  uploadedFileDownloadUrl,
} from "@/services/uploaded-file.service.ts";
import { getObject, objectExists } from "@/services/storage.service.ts";
import { MAX_UPLOAD_BYTES } from "@/utils/upload-types.ts";

const HAS_DB = !!(Deno.env.get("TEST_DATABASE_URL") || Deno.env.get("DATABASE_URL"));

/**
 * Same wrapper the other database-backed service tests use. The op
 * sanitizer sees the shared postgres.js connection as a leak, because it
 * outlives any single test on purpose.
 */
function dbTest(name: string, fn: () => Promise<void>) {
  Deno.test({ name, ignore: !HAS_DB, sanitizeResources: false, sanitizeOps: false, fn });
}

function pdf(text = "%PDF-1.7 sample"): Uint8Array {
  return new TextEncoder().encode(text);
}

interface StoreOverrides {
  filename?: string;
  contentType?: string;
  body?: Uint8Array;
  subjectType?: string | null;
  subjectId?: string | null;
  status?: "pending_review" | "approved" | "rejected";
  allow?: readonly ("pdf" | "png" | "csv")[];
}

function store(orgId: string, userId: string | null, overrides: StoreOverrides = {}) {
  return storeUploadedFile({
    organizationId: orgId,
    uploadedByUserId: userId,
    filename: overrides.filename ?? "receipt.pdf",
    contentType: overrides.contentType ?? "application/pdf",
    body: overrides.body ?? pdf(),
    subjectType: overrides.subjectType,
    subjectId: overrides.subjectId,
    status: overrides.status,
    allow: overrides.allow,
  });
}

// ── Storing ────────────────────────────────────────────────────────────────

dbTest("store: writes the bytes and records a pending row", async () => {
  const { user, org, cleanup } = await createIsolatedUser("editor");
  try {
    await withLocalStorage(async () => {
      const file = await store(org.id, user.id, { body: pdf("twelve bytes") });

      assertEquals(file.organizationId, org.id);
      assertEquals(file.uploadedBy, user.id);
      assertEquals(file.filename, "receipt.pdf");
      assertEquals(file.contentType, "application/pdf");
      assertEquals(file.sizeBytes, pdf("twelve bytes").length);
      // Fail closed: nobody has looked at it yet.
      assertEquals(file.status, "pending_review");
      assertEquals(file.reviewedBy, null);
      assertEquals(file.reviewedAt, null);

      // The bytes really are on the storage driver, under the key on the row.
      const stored = await getObject(file.storageKey);
      assertEquals(new TextDecoder().decode(stored.body), "twelve bytes");
    });
  } finally {
    await cleanup();
  }
});

dbTest("store: the SERVER picks the key, and it is unguessable", async () => {
  const { user, org, cleanup } = await createIsolatedUser("editor");
  try {
    await withLocalStorage(async () => {
      const a = await store(org.id, user.id);
      const b = await store(org.id, user.id);

      // Same filename, different keys: an upload can never overwrite an
      // earlier one, and a key cannot be guessed from the filename.
      assert(a.storageKey !== b.storageKey);
      assert(a.storageKey.startsWith(`uploads/${org.id}/`));
      assert(a.storageKey.endsWith(".pdf"), `expected the real extension: ${a.storageKey}`);
      assert(
        !a.storageKey.includes("receipt"),
        "the uploader's filename must not become part of the path",
      );
    });
  } finally {
    await cleanup();
  }
});

dbTest("store: a filename is display text, never a path", async () => {
  const { user, org, cleanup } = await createIsolatedUser("editor");
  try {
    await withLocalStorage(async () => {
      const file = await store(org.id, user.id, {
        filename: "../../etc/passwd/statement.pdf",
      });
      assertEquals(file.filename, "statement.pdf");
    });
  } finally {
    await cleanup();
  }
});

dbTest("store: the allowlist runs before anything is written", async () => {
  const { user, org, cleanup } = await createIsolatedUser("editor");
  try {
    await withLocalStorage(async ({ root }) => {
      await assertRejects(
        () =>
          store(org.id, user.id, {
            filename: "payload.exe",
            contentType: "application/octet-stream",
          }),
      );
      await assertRejects(
        () => store(org.id, user.id, { filename: "logo.png", contentType: "application/pdf" }),
      );
      await assertRejects(
        () => store(org.id, user.id, { body: new Uint8Array(MAX_UPLOAD_BYTES + 1) }),
      );

      // Nothing was written and nothing was recorded.
      assertEquals(await listUploadedFiles({ organizationId: org.id }), []);
      const objects = await Deno.stat(`${root}/objects`).catch(() => null);
      assertEquals(objects, null, "a refused upload must not create the objects tree");
    });
  } finally {
    await cleanup();
  }
});

dbTest("store: a per-call allow list narrows what this surface accepts", async () => {
  const { user, org, cleanup } = await createIsolatedUser("editor");
  try {
    await withLocalStorage(async () => {
      // A surface that only wants images refuses a PDF, even though the
      // app-wide allowlist permits one.
      await assertRejects(() => store(org.id, user.id, { allow: ["png"] }));
      const file = await store(org.id, user.id, {
        filename: "logo.png",
        contentType: "image/png",
        body: new TextEncoder().encode("PNG"),
        allow: ["png"],
      });
      assertEquals(file.contentType, "image/png");
    });
  } finally {
    await cleanup();
  }
});

dbTest("store: an app with no review step can approve on arrival", async () => {
  const { user, org, cleanup } = await createIsolatedUser("editor");
  try {
    await withLocalStorage(async () => {
      const file = await store(org.id, user.id, { status: "approved" });
      assertEquals(file.status, "approved");
      assertEquals(await countPendingReview(org.id), 0);
    });
  } finally {
    await cleanup();
  }
});

dbTest("store: the subject link is optional and round-trips", async () => {
  const { user, org, cleanup } = await createIsolatedUser("editor");
  try {
    await withLocalStorage(async () => {
      const unlinked = await store(org.id, user.id);
      assertEquals(unlinked.subjectType, null);
      assertEquals(unlinked.subjectId, null);

      const linked = await store(org.id, user.id, {
        subjectType: "expense",
        subjectId: "exp-42",
      });
      const found = await listUploadedFiles({
        organizationId: org.id,
        subjectType: "expense",
        subjectId: "exp-42",
      });
      assertEquals(found.length, 1);
      assertEquals(found[0].id, linked.id);
    });
  } finally {
    await cleanup();
  }
});

// ── Org scoping ────────────────────────────────────────────────────────────

dbTest("read: another workspace's file id is a 404, not a cross-tenant read", async () => {
  const a = await createIsolatedUser("owner");
  const b = await createIsolatedUser("owner");
  try {
    await withLocalStorage(async () => {
      const file = await store(a.org.id, a.user.id);

      // The id is real. The org scope in the WHERE clause is what refuses
      // it, not the route gate.
      const err = await assertRejects(
        () => getUploadedFile({ id: file.id, organizationId: b.org.id }),
      ) as { statusCode?: number };
      assertEquals(err.statusCode, 404);

      assertEquals(await listUploadedFiles({ organizationId: b.org.id }), []);
      assertEquals(await listPendingReview({ organizationId: b.org.id }), []);
    });
  } finally {
    await a.cleanup();
    await b.cleanup();
  }
});

dbTest("review: another workspace cannot approve or reject a file", async () => {
  const a = await createIsolatedUser("owner");
  const b = await createIsolatedUser("owner");
  try {
    await withLocalStorage(async () => {
      const file = await store(a.org.id, a.user.id);

      await assertRejects(() =>
        approveUploadedFile({
          id: file.id,
          organizationId: b.org.id,
          reviewerUserId: b.user.id,
        })
      );
      await assertRejects(() =>
        rejectUploadedFile({
          id: file.id,
          organizationId: b.org.id,
          reviewerUserId: b.user.id,
          reason: "not mine",
        })
      );

      // Untouched.
      const still = await getUploadedFile({ id: file.id, organizationId: a.org.id });
      assertEquals(still.status, "pending_review");
    });
  } finally {
    await a.cleanup();
    await b.cleanup();
  }
});

// ── The review lifecycle ───────────────────────────────────────────────────

dbTest("review: pending to approved stamps the reviewer", async () => {
  const { user, org, cleanup } = await createIsolatedUser("owner");
  try {
    await withLocalStorage(async () => {
      const file = await store(org.id, user.id);
      assertEquals(await countPendingReview(org.id), 1);

      const approved = await approveUploadedFile({
        id: file.id,
        organizationId: org.id,
        reviewerUserId: user.id,
      });

      assertEquals(approved.status, "approved");
      assertEquals(approved.reviewedBy, user.id);
      assert(approved.reviewedAt instanceof Date);
      assertEquals(approved.reviewReason, null);
      assertEquals(await countPendingReview(org.id), 0);
    });
  } finally {
    await cleanup();
  }
});

dbTest("review: pending to rejected keeps the reason", async () => {
  const { user, org, cleanup } = await createIsolatedUser("owner");
  try {
    await withLocalStorage(async () => {
      const file = await store(org.id, user.id);
      const rejected = await rejectUploadedFile({
        id: file.id,
        organizationId: org.id,
        reviewerUserId: user.id,
        reason: "The page is blurry.",
      });

      assertEquals(rejected.status, "rejected");
      assertEquals(rejected.reviewReason, "The page is blurry.");
      assertEquals(rejected.reviewedBy, user.id);
      assertEquals(await countPendingReview(org.id), 0);
    });
  } finally {
    await cleanup();
  }
});

dbTest("review: a rejection without a reason is refused", async () => {
  const { user, org, cleanup } = await createIsolatedUser("owner");
  try {
    await withLocalStorage(async () => {
      const file = await store(org.id, user.id);
      const err = await assertRejects(() =>
        rejectUploadedFile({
          id: file.id,
          organizationId: org.id,
          reviewerUserId: user.id,
          reason: "   ",
        })
      ) as { statusCode?: number };
      assertEquals(err.statusCode, 400);

      // Still in the queue: a refused decision is not a decision.
      assertEquals(await countPendingReview(org.id), 1);
    });
  } finally {
    await cleanup();
  }
});

dbTest("review: a reviewer may correct an earlier decision", async () => {
  const { user, org, cleanup } = await createIsolatedUser("owner");
  try {
    await withLocalStorage(async () => {
      const file = await store(org.id, user.id);

      await rejectUploadedFile({
        id: file.id,
        organizationId: org.id,
        reviewerUserId: user.id,
        reason: "Wrong document.",
      });
      const corrected = await approveUploadedFile({
        id: file.id,
        organizationId: org.id,
        reviewerUserId: user.id,
      });

      assertEquals(corrected.status, "approved");
      // The stale rejection reason is cleared, or the UI would show
      // "rejected: wrong document" beside an approved file.
      assertEquals(corrected.reviewReason, null);
    });
  } finally {
    await cleanup();
  }
});

dbTest("review: the queue is oldest first and holds only pending files", async () => {
  const { user, org, cleanup } = await createIsolatedUser("owner");
  try {
    await withLocalStorage(async () => {
      const first = await store(org.id, user.id, { filename: "one.pdf" });
      const second = await store(org.id, user.id, { filename: "two.pdf" });
      const third = await store(org.id, user.id, { filename: "three.pdf" });
      await approveUploadedFile({
        id: second.id,
        organizationId: org.id,
        reviewerUserId: user.id,
      });

      const queue = await listPendingReview({ organizationId: org.id });
      assertEquals(queue.map((f) => f.id), [first.id, third.id]);
      assertEquals(await countPendingReview(org.id), 2);
    });
  } finally {
    await cleanup();
  }
});

dbTest("review: reviewing a file that does not exist is a 404", async () => {
  const { user, org, cleanup } = await createIsolatedUser("owner");
  try {
    await withLocalStorage(async () => {
      const err = await assertRejects(() =>
        approveUploadedFile({
          id: crypto.randomUUID(),
          organizationId: org.id,
          reviewerUserId: user.id,
        })
      ) as { statusCode?: number };
      assertEquals(err.statusCode, 404);
    });
  } finally {
    await cleanup();
  }
});

// ── Who may read ───────────────────────────────────────────────────────────

dbTest("access: a pending file is visible to its uploader and to a reviewer only", async () => {
  const { user, org, cleanup } = await createIsolatedUser("editor");
  try {
    await withLocalStorage(async () => {
      const file = await store(org.id, user.id);

      const uploader = { id: user.id, role: "editor" };
      const otherEditor = { id: crypto.randomUUID(), role: "editor" };
      const reviewer = { id: crypto.randomUUID(), role: "admin" };
      const viewer = { id: crypto.randomUUID(), role: "viewer" };

      assertEquals(canReadUploadedFile(file, uploader), true);
      assertEquals(canReadUploadedFile(file, reviewer), true);
      // Nobody has vouched for it yet, so it goes no further.
      assertEquals(canReadUploadedFile(file, otherEditor), false);
      assertEquals(canReadUploadedFile(file, viewer), false);
    });
  } finally {
    await cleanup();
  }
});

dbTest("access: approving opens the file to the whole workspace", async () => {
  const { user, org, cleanup } = await createIsolatedUser("owner");
  try {
    await withLocalStorage(async () => {
      const file = await store(org.id, user.id);
      const approved = await approveUploadedFile({
        id: file.id,
        organizationId: org.id,
        reviewerUserId: user.id,
      });
      const viewer = { id: crypto.randomUUID(), role: "viewer" };
      assertEquals(canReadUploadedFile(approved, viewer), true);
    });
  } finally {
    await cleanup();
  }
});

dbTest("access: a rejected file closes again to everyone but its uploader", async () => {
  const { user, org, cleanup } = await createIsolatedUser("owner");
  try {
    await withLocalStorage(async () => {
      const file = await store(org.id, user.id);
      const rejected = await rejectUploadedFile({
        id: file.id,
        organizationId: org.id,
        reviewerUserId: user.id,
        reason: "Not legible.",
      });
      assertEquals(canReadUploadedFile(rejected, { id: user.id, role: "owner" }), true);
      assertEquals(
        canReadUploadedFile(rejected, { id: crypto.randomUUID(), role: "editor" }),
        false,
      );
    });
  } finally {
    await cleanup();
  }
});

dbTest("access: deleting is the uploader's or a reviewer's call", async () => {
  const { user, org, cleanup } = await createIsolatedUser("editor");
  try {
    await withLocalStorage(async () => {
      const file = await store(org.id, user.id);
      assertEquals(canDeleteUploadedFile(file, { id: user.id, role: "editor" }), true);
      assertEquals(canDeleteUploadedFile(file, { id: crypto.randomUUID(), role: "admin" }), true);
      assertEquals(
        canDeleteUploadedFile(file, { id: crypto.randomUUID(), role: "editor" }),
        false,
      );
    });
  } finally {
    await cleanup();
  }
});

// ── Download URLs ──────────────────────────────────────────────────────────

dbTest("download: a signed URL is minted for whichever driver is active", async () => {
  const { user, org, cleanup } = await createIsolatedUser("editor");
  try {
    await withLocalStorage(async () => {
      const file = await store(org.id, user.id);
      const url = uploadedFileDownloadUrl(file);
      assert(url.includes("sig="), `expected a signed URL, got ${url}`);

      const named = uploadedFileDownloadUrl(file, { forceDownload: true });
      assert(named.includes("disposition="));
      assert(decodeURIComponent(named).includes('filename="receipt.pdf"'));
    });
  } finally {
    await cleanup();
  }
});

// ── Deleting ───────────────────────────────────────────────────────────────

dbTest("delete: removes the row and the bytes", async () => {
  const { user, org, cleanup } = await createIsolatedUser("owner");
  try {
    await withLocalStorage(async () => {
      const file = await store(org.id, user.id);
      assertEquals(await objectExists(file.storageKey), true);

      await deleteUploadedFile({ id: file.id, organizationId: org.id });

      assertEquals(await objectExists(file.storageKey), false);
      await assertRejects(() => getUploadedFile({ id: file.id, organizationId: org.id }));
    });
  } finally {
    await cleanup();
  }
});

dbTest("delete: another workspace cannot delete the file or its bytes", async () => {
  const a = await createIsolatedUser("owner");
  const b = await createIsolatedUser("owner");
  try {
    await withLocalStorage(async () => {
      const file = await store(a.org.id, a.user.id);
      await assertRejects(() => deleteUploadedFile({ id: file.id, organizationId: b.org.id }));
      assertEquals(await objectExists(file.storageKey), true);
    });
  } finally {
    await a.cleanup();
    await b.cleanup();
  }
});

dbTest("delete: removing the org cascades the file rows away", async () => {
  const { user, org, cleanup } = await createIsolatedUser("owner");
  let fileId = "";
  try {
    await withLocalStorage(async () => {
      fileId = (await store(org.id, user.id)).id;
    });
  } finally {
    await cleanup();
  }

  const row = await getTestDb()
    .selectFrom("uploaded_files")
    .select(["id"])
    .where("id", "=", fileId)
    .executeTakeFirst();
  assertEquals(row, undefined);
});
