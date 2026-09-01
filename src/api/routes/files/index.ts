/**
 * File routes -- the paved road for end-user uploads.
 *
 * Two layers live here, and almost every feature wants the first one.
 *
 * MANAGED UPLOADS (`/api/files/uploads/...`)
 *   The whole road: the accepted-types allowlist, a server-picked
 *   storage key, a metadata row, a review queue, and status-gated
 *   download URLs. `<UploadField>` in the SPA talks to exactly these.
 *   A ticket that says "let people attach a receipt" wires up this
 *   layer and writes no storage code at all.
 *
 * RAW STORAGE (`/api/files/upload-url`, `/upload`, `/download-url`)
 *   The thin wrapper over storage.service.ts that predates the managed
 *   layer. Still here, still useful for machine-to-machine writes and
 *   for large files that should go straight to the store. It enforces
 *   the SAME allowlist, so nothing can arrive through the side door
 *   that the front door would refuse. It records no row, so a file
 *   uploaded this way is invisible to the review queue: reach for it
 *   deliberately, not by default.
 *
 *   Because it records no row, the KEY is the only thing that can carry
 *   the tenant, so every key on these routes goes through
 *   `orgScopedRawKey()` and comes back bound to the caller's workspace.
 *   Skipping that is not a small omission: the managed layer publishes
 *   the full storage key inside the signed URL it hands the browser, so
 *   an unscoped raw route lets any member lift a key off their own
 *   download, edit the org id, and read, replace or destroy another
 *   workspace's file (CWE-639). The managed namespace is refused here
 *   outright, because those objects have per-file rules these routes
 *   cannot see.
 *
 * All routes require auth. The one public file surface is the signed
 * object route of the local storage driver (`/api/storage/local/o`),
 * where the signature is the credential, exactly as it is for a
 * presigned R2 URL.
 *
 * Storage is ALWAYS available (R2 when configured, a local directory
 * otherwise), so no route here gates on whether it is set up.
 */

import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { validationHook } from "@/utils/zod-validation-hook.ts";
import { getUser, requireAuth, requireCapability } from "@/api/middleware/auth.ts";
import { log } from "@/lib/logger.ts";
import { BadRequestError, ForbiddenError } from "@/utils/errors.ts";
import {
  deleteObject,
  describeStorageConfig,
  getSignedDownloadUrl,
  getSignedUploadUrl,
  putObject,
} from "@/services/storage.service.ts";
import { orgScopedRawKey } from "@/services/storage-keys.ts";
import {
  assertAllowedUpload,
  describeUploadPolicy,
  MAX_UPLOAD_BYTES,
} from "@/utils/upload-types.ts";
import {
  approveUploadedFile,
  assertCanReadUploadedFile,
  canDeleteUploadedFile,
  countPendingReview,
  deleteUploadedFile,
  getUploadedFile,
  listPendingReview,
  listVisibleUploadedFiles,
  rejectUploadedFile,
  storeUploadedFile,
  type UploadedFile,
  uploadedFileDownloadUrl,
} from "@/services/uploaded-file.service.ts";

const fileRoutes = new Hono();

// All routes require auth. File storage is per-user and per-tenant.
fileRoutes.use("*", requireAuth);

/**
 * Refuse an oversized body before it is buffered. The size check in the
 * allowlist runs on bytes we have already read; this one runs on the
 * Content-Length, so a 2 GB request costs nothing.
 */
const limitUploadBody = bodyLimit({
  maxSize: MAX_UPLOAD_BYTES,
  onError: () => {
    throw new BadRequestError(`The upload exceeds the ${MAX_UPLOAD_BYTES} byte limit.`);
  },
});

/** What the SPA renders for a file. Never exposes the storage key. */
function serializeFile(file: UploadedFile) {
  return {
    id: file.id,
    filename: file.filename,
    contentType: file.contentType,
    sizeBytes: file.sizeBytes,
    status: file.status,
    subjectType: file.subjectType,
    subjectId: file.subjectId,
    uploadedBy: file.uploadedBy,
    reviewReason: file.reviewReason,
    reviewedBy: file.reviewedBy,
    reviewedAt: file.reviewedAt,
    createdAt: file.createdAt,
  };
}

// ── Info + policy ──────────────────────────────────────────────────────────

fileRoutes.get("/info", (c) => {
  const cfg = describeStorageConfig();
  return c.json({
    data: {
      ...cfg,
      note: cfg.durable
        ? "Files are in R2, under this project's key prefix, and survive a redeploy."
        : "R2 is not configured, so files are on local disk. Uploads work, but they do " +
          "NOT survive a redeploy. Set R2_ENDPOINT / R2_BUCKET / R2_ACCESS_KEY_ID / " +
          "R2_SECRET_ACCESS_KEY for durable storage.",
    },
  });
});

/**
 * What the browser is allowed to send. The file picker reads this so the
 * `accept` attribute and the client-side pre-check can never drift from
 * what the server will actually take.
 */
fileRoutes.get("/upload-policy", (c) => {
  return c.json({ data: describeUploadPolicy() });
});

// ── Managed uploads ────────────────────────────────────────────────────────

const subjectFields = {
  subjectType: z.string().trim().min(1).max(64).nullish(),
  subjectId: z.string().trim().min(1).max(255).nullish(),
};

fileRoutes.post("/uploads", limitUploadBody, async (c) => {
  const user = getUser(c);

  const contentType = c.req.header("content-type") ?? "";
  if (!contentType.startsWith("multipart/form-data")) {
    throw new BadRequestError("Send multipart/form-data with a `file` field.");
  }

  const form = await c.req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) {
    throw new BadRequestError("`file` field is required and must be a file.");
  }

  const subject = z.object(subjectFields).safeParse({
    subjectType: form.get("subjectType") ?? undefined,
    subjectId: form.get("subjectId") ?? undefined,
  });
  if (!subject.success) {
    throw new BadRequestError(subject.error.issues[0]?.message ?? "Invalid subject.");
  }

  const stored = await storeUploadedFile({
    organizationId: user.organizationId,
    uploadedByUserId: user.id,
    filename: file.name,
    contentType: file.type,
    body: new Uint8Array(await file.arrayBuffer()),
    subjectType: subject.data.subjectType ?? null,
    subjectId: subject.data.subjectId ?? null,
  });

  return c.json({ data: serializeFile(stored) }, 201);
});

fileRoutes.get("/uploads", async (c) => {
  const user = getUser(c);
  const status = c.req.query("status");
  if (status && !["pending_review", "approved", "rejected"].includes(status)) {
    throw new BadRequestError("Unknown status filter.");
  }

  const files = await listVisibleUploadedFiles({
    organizationId: user.organizationId,
    viewer: { id: user.id, role: user.role },
    status: status as "pending_review" | "approved" | "rejected" | undefined,
    subjectType: c.req.query("subjectType") || undefined,
    subjectId: c.req.query("subjectId") || undefined,
  });

  return c.json({ data: files.map(serializeFile) });
});

fileRoutes.get("/uploads/:id", async (c) => {
  const user = getUser(c);
  const file = await getUploadedFile({
    id: c.req.param("id"),
    organizationId: user.organizationId,
  });
  assertCanReadUploadedFile(file, { id: user.id, role: user.role });
  return c.json({ data: serializeFile(file) });
});

/**
 * A fresh signed URL for the bytes.
 *
 * The status gate lives here, not in the storage layer: a signed URL,
 * once minted, is a bearer token that nothing can take back. So the
 * decision about who may hold one is made before it exists.
 */
fileRoutes.get("/uploads/:id/download-url", async (c) => {
  const user = getUser(c);
  const file = await getUploadedFile({
    id: c.req.param("id"),
    organizationId: user.organizationId,
  });
  assertCanReadUploadedFile(file, { id: user.id, role: user.role });

  const url = uploadedFileDownloadUrl(file, {
    expiresInSeconds: 900,
    forceDownload: c.req.query("download") === "true",
  });

  return c.json({
    data: {
      downloadUrl: url,
      filename: file.filename,
      contentType: file.contentType,
      expiresAt: new Date(Date.now() + 900 * 1000).toISOString(),
    },
  });
});

fileRoutes.delete("/uploads/:id", async (c) => {
  const user = getUser(c);
  const file = await getUploadedFile({
    id: c.req.param("id"),
    organizationId: user.organizationId,
  });
  if (!canDeleteUploadedFile(file, { id: user.id, role: user.role })) {
    throw new ForbiddenError(
      "Only the person who uploaded this file, or a reviewer, can remove it.",
    );
  }
  await deleteUploadedFile({ id: file.id, organizationId: user.organizationId });
  return c.json({ data: { deleted: true, id: file.id } });
});

// ── Review queue ───────────────────────────────────────────────────────────
//
// `files.review` (admin and above). Deciding whether someone else's file
// is fit to be served is the same class of call as adding a member.

fileRoutes.get("/review-queue", requireCapability("files.review"), async (c) => {
  const user = getUser(c);
  const files = await listPendingReview({ organizationId: user.organizationId });
  return c.json({
    data: { files: files.map(serializeFile), pendingCount: files.length },
  });
});

fileRoutes.get("/review-queue/count", requireCapability("files.review"), async (c) => {
  const user = getUser(c);
  return c.json({ data: { pendingCount: await countPendingReview(user.organizationId) } });
});

fileRoutes.post("/uploads/:id/approve", requireCapability("files.review"), async (c) => {
  const user = getUser(c);
  const file = await approveUploadedFile({
    id: c.req.param("id"),
    organizationId: user.organizationId,
    reviewerUserId: user.id,
  });
  return c.json({ data: serializeFile(file) });
});

const rejectSchema = z.object({
  // Required, and required to be more than whitespace. A rejection
  // nobody can explain becomes a support ticket.
  reason: z.string().trim().min(1).max(1000),
});

fileRoutes.post(
  "/uploads/:id/reject",
  requireCapability("files.review"),
  zValidator("json", rejectSchema, validationHook),
  async (c) => {
    const user = getUser(c);
    const file = await rejectUploadedFile({
      // `?? ""` because the zValidator wrapper widens the param type to
      // `string | undefined`. An empty id is a 404 from the service.
      id: c.req.param("id") ?? "",
      organizationId: user.organizationId,
      reviewerUserId: user.id,
      reason: c.req.valid("json").reason,
    });
    return c.json({ data: serializeFile(file) });
  },
);

// ── Raw storage ────────────────────────────────────────────────────────────

const relativeKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(900)
  // Application-level keys: alnum + `_-./`. The service layer rejects
  // `..` segments; this regex is a coarse pre-filter that keeps
  // surprising characters (spaces, quotes, control chars) out of a path.
  .regex(/^[A-Za-z0-9_\-./]+$/, "key must contain only [A-Za-z0-9_-./]");

const uploadUrlSchema = z.object({
  /** Relative key. The project prefix is added by the service. */
  key: relativeKeySchema,
  /** MIME type the browser will send. Signed into the URL. */
  contentType: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .regex(/^[A-Za-z0-9!#$&^_+.\-/]+$/, "contentType has invalid characters"),
  /** TTL in seconds. Default 900 (15 min). Max 7d. */
  expiresInSeconds: z.number().int().min(1).max(604_800).optional(),
});

fileRoutes.post(
  "/upload-url",
  requireCapability("app.write"),
  zValidator("json", uploadUrlSchema, validationHook),
  (c) => {
    const user = getUser(c);
    const { key, contentType, expiresInSeconds } = c.req.valid("json");
    // Scope BEFORE minting. A presigned URL cannot be recalled, so the
    // tenant has to be decided while there is still something to refuse.
    const scoped = orgScopedRawKey(key, user.organizationId);
    // The same allowlist as the managed path. A presigned URL is a
    // capability to write, so the type is decided BEFORE it is minted:
    // once the URL exists, nothing here can inspect what goes through it.
    assertAllowedUpload({ filename: scoped, contentType });

    const ttl = expiresInSeconds ?? 900;
    const url = getSignedUploadUrl(scoped, contentType, ttl);
    log.info("Issued upload URL", {
      source: "files",
      feature: "upload-url",
      key: scoped,
      contentType,
      ttl,
    });
    return c.json({
      uploadUrl: url,
      // The SCOPED key: the client stores this and sends it back, and
      // the scoping is idempotent so the round trip is stable.
      key: scoped,
      expiresInSeconds: ttl,
      expiresAt: new Date(Date.now() + ttl * 1000).toISOString(),
      // Echo what the browser MUST send, so a frontend that copies this
      // cannot use a different content type and break the signature.
      requiredHeaders: { "Content-Type": contentType },
    });
  },
);

const downloadUrlSchema = z.object({
  key: relativeKeySchema,
  expiresInSeconds: z.number().int().min(1).max(604_800).optional(),
  /** Force a download with this filename instead of inline display. */
  downloadFilename: z.string().trim().max(255).optional(),
});

fileRoutes.post(
  "/download-url",
  zValidator("json", downloadUrlSchema, validationHook),
  (c) => {
    const user = getUser(c);
    const { key, expiresInSeconds, downloadFilename } = c.req.valid("json");
    const scoped = orgScopedRawKey(key, user.organizationId);
    const ttl = expiresInSeconds ?? 3600;
    const responseDisposition = downloadFilename
      ? `attachment; filename="${downloadFilename.replace(/"/g, "")}"`
      : undefined;
    const url = getSignedDownloadUrl(scoped, ttl, { responseDisposition });
    return c.json({
      downloadUrl: url,
      key: scoped,
      expiresInSeconds: ttl,
      expiresAt: new Date(Date.now() + ttl * 1000).toISOString(),
    });
  },
);

fileRoutes.post("/upload", requireCapability("app.write"), limitUploadBody, async (c) => {
  const user = getUser(c);
  const ct = c.req.header("content-type") ?? "";
  if (!ct.startsWith("multipart/form-data")) {
    throw new BadRequestError("Use multipart/form-data: { file, key }");
  }

  const form = await c.req.formData();
  const file = form.get("file");
  const keyField = form.get("key");
  if (!(file instanceof File)) {
    throw new BadRequestError("`file` field is required and must be a file");
  }
  if (typeof keyField !== "string" || !keyField.trim()) {
    throw new BadRequestError("`key` field is required (relative key)");
  }
  // Run the relative key through the same regex as the JSON routes so
  // multipart callers get the same guarantees.
  const parsed = relativeKeySchema.safeParse(keyField);
  if (!parsed.success) {
    throw new BadRequestError(`key: ${parsed.error.issues[0]?.message ?? "invalid"}`);
  }

  const scoped = orgScopedRawKey(parsed.data, user.organizationId);

  // Judge the FILE, not the key: this path has real bytes, a real name
  // and a real size, so all three are checked.
  const accepted = assertAllowedUpload({
    filename: file.name || scoped,
    contentType: file.type,
    sizeBytes: file.size,
  });

  const buffer = new Uint8Array(await file.arrayBuffer());
  const result = await putObject({
    key: scoped,
    body: buffer,
    contentType: accepted.contentType,
  });

  log.info("Server-side upload", {
    source: "files",
    feature: "proxy-upload",
    key: result.key,
    bytes: buffer.length,
  });

  return c.json({
    key: result.key,
    fullKey: result.fullKey,
    bucket: result.bucket,
    url: result.url, // store this in your DB
    bytes: buffer.length,
  });
});

const deleteSchema = z.object({ key: relativeKeySchema });

fileRoutes.delete(
  "/",
  requireCapability("app.write"),
  zValidator("json", deleteSchema, validationHook),
  async (c) => {
    const user = getUser(c);
    const { key } = c.req.valid("json");
    const scoped = orgScopedRawKey(key, user.organizationId);
    await deleteObject(scoped);
    log.info("File deleted", {
      source: "files",
      feature: "delete",
      key: scoped,
    });
    return c.json({ ok: true, key: scoped });
  },
);

export { fileRoutes };
