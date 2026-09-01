/**
 * Uploaded files -- the paved road for end-user file uploads.
 *
 * One call stores a file: it checks the type against the shared
 * allowlist, picks the storage key, writes the bytes through whichever
 * storage driver is active, and records the row. An agent ticket that
 * says "let people attach a receipt" registers a subject and renders
 * <UploadField>; it does not rebuild any of this.
 *
 * Three decisions worth knowing about, because each one closes a bug
 * class that customer apps kept re-opening:
 *
 * THE SERVER PICKS THE KEY. Callers never supply one. A caller-chosen
 * key is a caller-chosen collision, a caller-chosen probe of what else
 * exists, and a caller-chosen filename in someone else's folder. The key
 * is `uploads/<orgId>/<uuid><ext>`, which is unguessable and unique by
 * construction. The original filename is kept as DISPLAY text on the
 * row, never as a path.
 *
 * EVERY QUERY IS ORG-SCOPED IN ITS WHERE CLAUSE. A file id from another
 * workspace is a 404, not a cross-tenant read (CWE-639). The route gate
 * is not the authorization check.
 *
 * A NEW FILE IS pending_review. That is the fail-closed default: a file
 * nobody has looked at is served to its uploader and to a reviewer, and
 * to nobody else. An app that does not want a queue passes
 * `status: "approved"` at store time and never opens the screen. An app
 * that does gets `listPendingReview` / `approve` / `reject` for free.
 */

import { db } from "@/db/client.ts";
import type { UploadedFileRow, UploadedFileStatus } from "@/db/schema.ts";
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from "@/utils/errors.ts";
import { log } from "@/lib/logger.ts";
import { can } from "@/lib/roles.ts";
import { deleteObject, getSignedDownloadUrl, putObject } from "@/services/storage.service.ts";
import { assertAllowedUpload, type UploadTypeId } from "@/utils/upload-types.ts";

const LOG_SOURCE = "uploaded-files";

/** The capability a person needs to see and decide on other people's files. */
export const REVIEW_CAPABILITY = "files.review" as const;

export interface UploadedFile {
  id: string;
  organizationId: string;
  uploadedBy: string | null;
  subjectType: string | null;
  subjectId: string | null;
  /** RELATIVE storage key. Feed it straight to storage.service.ts. */
  storageKey: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  status: UploadedFileStatus;
  reviewReason: string | null;
  reviewedBy: string | null;
  reviewedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface UploadViewer {
  id: string;
  role: string;
}

// ── Store ──────────────────────────────────────────────────────────────────

export interface StoreUploadedFileInput {
  organizationId: string;
  /** NULL for a system-generated file with no human behind it. */
  uploadedByUserId: string | null;
  /** The name the person's machine gave it. Display text, never a path. */
  filename: string;
  contentType: string;
  body: Uint8Array;
  subjectType?: string | null;
  subjectId?: string | null;
  /** Narrow the accepted types for this call. Never widens the allowlist. */
  allow?: readonly UploadTypeId[];
  /** Lower the size cap for this call. Never raises it. */
  maxBytes?: number;
  /** Skip the queue. Use when this app has no review step. */
  status?: UploadedFileStatus;
}

export async function storeUploadedFile(
  input: StoreUploadedFileInput,
): Promise<UploadedFile> {
  // The allowlist runs FIRST. Nothing reaches storage that the app would
  // then have to delete.
  const accepted = assertAllowedUpload({
    filename: input.filename,
    contentType: input.contentType,
    sizeBytes: input.body.length,
  }, { allow: input.allow, maxBytes: input.maxBytes });

  const storageKey = buildStorageKey(input.organizationId, accepted.extension);

  await putObject({
    key: storageKey,
    body: input.body,
    // The RESOLVED content type, not the one the client sent. They are
    // the same string here only because the allowlist just proved it.
    contentType: accepted.contentType,
  });

  try {
    const row = await db
      .insertInto("uploaded_files")
      .values({
        organizationId: input.organizationId,
        uploadedBy: input.uploadedByUserId,
        subjectType: input.subjectType ?? null,
        subjectId: input.subjectId ?? null,
        storageKey,
        filename: displayFilename(input.filename),
        contentType: accepted.contentType,
        sizeBytes: input.body.length,
        status: input.status ?? "pending_review",
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    log.info("File uploaded", {
      source: LOG_SOURCE,
      feature: "store",
      fileId: row.id,
      organizationId: input.organizationId,
      contentType: accepted.contentType,
      bytes: input.body.length,
      status: row.status,
    });

    return toUploadedFile(row);
  } catch (err) {
    // The bytes are already written. Leaving them would be an orphan
    // nothing points at and nothing will ever clean up, so undo the
    // write before surfacing the failure.
    await deleteObject(storageKey).catch((cleanupErr) => {
      log.error(
        "Could not remove the stored object after its row failed to insert",
        { source: LOG_SOURCE, feature: "store-rollback", storageKey },
        cleanupErr as Error,
      );
    });

    if (isUniqueViolation(err)) {
      throw new ConflictError("That file has already been uploaded.");
    }
    throw err;
  }
}

/**
 * The key shape. Unguessable, unique, org-partitioned, and carrying the
 * real extension so a downstream tool that sniffs by suffix still works.
 */
function buildStorageKey(organizationId: string, extension: string): string {
  return `uploads/${organizationId}/${crypto.randomUUID()}${extension}`;
}

/**
 * Filenames are display text. Strip anything path-shaped and bound the
 * length, so a name can never be mistaken for a location and a very long
 * one cannot bloat a row or a header.
 */
function displayFilename(filename: string): string {
  const base = filename.trim().split(/[\\/]/).pop() ?? "";
  // Control characters would corrupt a Content-Disposition header.
  // deno-lint-ignore no-control-regex
  return base.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 255) || "file";
}

// ── Read ───────────────────────────────────────────────────────────────────

export async function getUploadedFile(opts: {
  id: string;
  organizationId: string;
}): Promise<UploadedFile> {
  const row = await db
    .selectFrom("uploaded_files")
    .selectAll()
    .where("id", "=", opts.id)
    .where("organizationId", "=", opts.organizationId)
    .executeTakeFirst();

  // Another workspace's id is indistinguishable from a made-up one.
  if (!row) throw new NotFoundError("File");
  return toUploadedFile(row);
}

export interface ListUploadedFilesOptions {
  organizationId: string;
  status?: UploadedFileStatus;
  subjectType?: string | null;
  subjectId?: string | null;
  /** Only this person's uploads. */
  uploadedBy?: string;
  limit?: number;
}

export async function listUploadedFiles(
  opts: ListUploadedFilesOptions,
): Promise<UploadedFile[]> {
  let query = db
    .selectFrom("uploaded_files")
    .selectAll()
    .where("organizationId", "=", opts.organizationId);

  if (opts.status) query = query.where("status", "=", opts.status);
  if (opts.subjectType) query = query.where("subjectType", "=", opts.subjectType);
  if (opts.subjectId) query = query.where("subjectId", "=", opts.subjectId);
  if (opts.uploadedBy) query = query.where("uploadedBy", "=", opts.uploadedBy);

  const rows = await query
    .orderBy("createdAt", "desc")
    .limit(Math.min(Math.max(opts.limit ?? 100, 1), 500))
    .execute();

  return rows.map(toUploadedFile);
}

/**
 * The review queue: oldest first, because a queue is worked from the
 * front and the person who has waited longest should not wait longer.
 */
export async function listPendingReview(opts: {
  organizationId: string;
  limit?: number;
}): Promise<UploadedFile[]> {
  const rows = await db
    .selectFrom("uploaded_files")
    .selectAll()
    .where("organizationId", "=", opts.organizationId)
    .where("status", "=", "pending_review")
    .orderBy("createdAt", "asc")
    .limit(Math.min(Math.max(opts.limit ?? 100, 1), 500))
    .execute();

  return rows.map(toUploadedFile);
}

export async function countPendingReview(organizationId: string): Promise<number> {
  const row = await db
    .selectFrom("uploaded_files")
    .select(({ fn }) => [fn.countAll<string>().as("count")])
    .where("organizationId", "=", organizationId)
    .where("status", "=", "pending_review")
    .executeTakeFirst();
  // countAll() comes back as a string.
  return Number(row?.count ?? 0);
}

// ── Review ─────────────────────────────────────────────────────────────────

export async function approveUploadedFile(opts: {
  id: string;
  organizationId: string;
  reviewerUserId: string;
}): Promise<UploadedFile> {
  return await recordDecision({
    ...opts,
    status: "approved",
    // Approving clears a previous rejection's reason. Leaving it would
    // show "rejected: blurry" beside a file that is now approved.
    reason: null,
  });
}

export async function rejectUploadedFile(opts: {
  id: string;
  organizationId: string;
  reviewerUserId: string;
  reason: string;
}): Promise<UploadedFile> {
  const reason = (opts.reason ?? "").trim();
  // A rejection with no reason is a support ticket. Require one.
  if (!reason) throw new BadRequestError("A rejection needs a reason.");
  return await recordDecision({ ...opts, status: "rejected", reason: reason.slice(0, 1000) });
}

/**
 * Both decisions, one write. A reviewer may CORRECT an earlier call
 * (approved to rejected and back): a queue that cannot be corrected just
 * moves the mistake somewhere a person cannot reach it. Each write
 * re-stamps who decided and when, so the audit trail is the latest
 * decision plus the log line for every one before it.
 */
async function recordDecision(opts: {
  id: string;
  organizationId: string;
  reviewerUserId: string;
  status: UploadedFileStatus;
  reason: string | null;
}): Promise<UploadedFile> {
  const row = await db
    .updateTable("uploaded_files")
    .set({
      status: opts.status,
      reviewReason: opts.reason,
      reviewedBy: opts.reviewerUserId,
      reviewedAt: new Date(),
    })
    .where("id", "=", opts.id)
    .where("organizationId", "=", opts.organizationId)
    .returningAll()
    .executeTakeFirst();

  if (!row) throw new NotFoundError("File");

  log.info("File review decision recorded", {
    source: LOG_SOURCE,
    feature: "review",
    fileId: opts.id,
    organizationId: opts.organizationId,
    reviewerUserId: opts.reviewerUserId,
    status: opts.status,
  });

  return toUploadedFile(row);
}

// ── Delete ─────────────────────────────────────────────────────────────────

/**
 * Remove the row and then the bytes.
 *
 * That order on purpose: if the object delete fails we are left with
 * bytes nothing references, which is recoverable. The other order can
 * leave a row pointing at nothing, which every reader then has to handle.
 */
export async function deleteUploadedFile(opts: {
  id: string;
  organizationId: string;
}): Promise<void> {
  const row = await db
    .deleteFrom("uploaded_files")
    .where("id", "=", opts.id)
    .where("organizationId", "=", opts.organizationId)
    .returning(["storageKey"])
    .executeTakeFirst();

  if (!row) throw new NotFoundError("File");

  try {
    await deleteObject(row.storageKey);
  } catch (err) {
    log.error(
      "File row deleted but its stored object could not be removed",
      { source: LOG_SOURCE, feature: "delete", fileId: opts.id, storageKey: row.storageKey },
      err as Error,
    );
  }

  log.info("File deleted", {
    source: LOG_SOURCE,
    feature: "delete",
    fileId: opts.id,
    organizationId: opts.organizationId,
  });
}

// ── Access ─────────────────────────────────────────────────────────────────

/**
 * Who may read the bytes.
 *
 *   approved              anyone in the workspace
 *   pending / rejected    the person who uploaded it, and a reviewer
 *
 * The middle case is the one that matters. A reviewer has to open a
 * pending file to review it, and an uploader has to be able to see what
 * they just sent. Nobody else does, because nobody has vouched for it
 * yet, and "we served an unreviewed file to the whole workspace" is the
 * failure a review queue exists to prevent.
 */
export function canReadUploadedFile(file: UploadedFile, viewer: UploadViewer): boolean {
  if (file.status === "approved") return true;
  if (file.uploadedBy && file.uploadedBy === viewer.id) return true;
  return can(viewer.role, REVIEW_CAPABILITY);
}

export function assertCanReadUploadedFile(file: UploadedFile, viewer: UploadViewer): void {
  if (!canReadUploadedFile(file, viewer)) {
    throw new ForbiddenError("This file is waiting on review.");
  }
}

/** Who may delete it: the uploader, or a reviewer. */
export function canDeleteUploadedFile(file: UploadedFile, viewer: UploadViewer): boolean {
  if (file.uploadedBy && file.uploadedBy === viewer.id) return true;
  return can(viewer.role, REVIEW_CAPABILITY);
}

/**
 * A fresh time-limited URL for the bytes. Works on either storage
 * driver; the caller does not know or care which.
 */
export function uploadedFileDownloadUrl(
  file: UploadedFile,
  opts: { expiresInSeconds?: number; forceDownload?: boolean } = {},
): string {
  const disposition = opts.forceDownload
    ? `attachment; filename="${headerSafeFilename(file.filename)}"`
    : undefined;
  return getSignedDownloadUrl(file.storageKey, opts.expiresInSeconds ?? 900, {
    responseDisposition: disposition,
  });
}

/** Quote-safe for a Content-Disposition header. */
function headerSafeFilename(filename: string): string {
  return filename.replace(/["\\]/g, "");
}

// ── Internals ──────────────────────────────────────────────────────────────

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err &&
    (err as { code?: string }).code === "23505";
}

function toUploadedFile(row: UploadedFileRow): UploadedFile {
  return {
    id: row.id,
    organizationId: row.organizationId,
    uploadedBy: row.uploadedBy ?? null,
    subjectType: row.subjectType ?? null,
    subjectId: row.subjectId ?? null,
    storageKey: row.storageKey,
    filename: row.filename,
    contentType: row.contentType,
    // BIGINT arrives as a string from the driver.
    sizeBytes: Number(row.sizeBytes),
    status: row.status,
    reviewReason: row.reviewReason ?? null,
    reviewedBy: row.reviewedBy ?? null,
    reviewedAt: row.reviewedAt ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
