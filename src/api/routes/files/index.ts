/**
 * File storage routes — tenant-isolated R2 upload + signed URLs.
 *
 * All routes require auth. The agent (and customer app code) builds
 * features on top of these — e.g. a Pinterest-style image upload, a
 * profile photo, a font upload — without having to think about
 * cross-tenant isolation: every key written/read here is auto-
 * prefixed with this project's R2_KEY_PREFIX in the storage service.
 *
 * Routes:
 *   POST /api/files/upload-url   — presigned PUT URL for direct browser upload
 *   GET  /api/files/download-url — presigned GET URL for serving a file
 *   POST /api/files/upload       — server-side proxy upload (small files)
 *   DELETE /api/files            — delete a file by relative key
 *
 * The "relative key" is the application-level path (e.g.
 * `users/abc/avatar.png`); the customer app picks the shape based
 * on its own data model. The R2 prefix (`customer-${projectId}/`)
 * is auto-prepended so different customer apps cannot collide on
 * keys or read each other's files even if they happened to pick
 * the same relative path.
 */

import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { validationHook } from "@/utils/zod-validation-hook.ts";
import { requireAuth } from "@/api/middleware/auth.ts";
import { log } from "@/lib/logger.ts";
import { BadRequestError } from "@/utils/errors.ts";
import {
  deleteObject,
  describeStorageConfig,
  getSignedDownloadUrl,
  getSignedUploadUrl,
  isStorageConfigured,
  putObject,
} from "@/services/storage.service.ts";

const fileRoutes = new Hono();

// All routes require auth — file storage is per-user / per-tenant.
fileRoutes.use("*", requireAuth);

// ── Health / info ──────────────────────────────────────────────────────────

fileRoutes.get("/info", (c) => {
  const cfg = describeStorageConfig();
  return c.json({
    configured: cfg.configured,
    bucket: cfg.bucket,
    prefix: cfg.prefix,
    note: cfg.configured
      ? "All keys are auto-prefixed with `prefix` for cross-tenant isolation."
      : "R2 not configured. Set R2_ENDPOINT / R2_BUCKET / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY.",
  });
});

// ── Presigned URL routes ───────────────────────────────────────────────────

const relativeKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(900)
  // Application-level keys: alnum + `_-./`. Reject `..` segments at the
  // service layer; this regex is a coarse pre-filter that keeps
  // surprising chars (spaces, quotes, control chars) out of R2 paths.
  .regex(/^[A-Za-z0-9_\-./]+$/, "key must contain only [A-Za-z0-9_-./]");

const uploadUrlSchema = z.object({
  /** Relative key — the project prefix is added by the service. */
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
  zValidator("json", uploadUrlSchema, validationHook),
  (c) => {
    const { key, contentType, expiresInSeconds } = c.req.valid("json");
    if (!isStorageConfigured()) {
      throw new BadRequestError("File storage is not configured on this app");
    }
    const ttl = expiresInSeconds ?? 900;
    const url = getSignedUploadUrl(key, contentType, ttl);
    log.info("Issued upload URL", {
      source: "files",
      feature: "upload-url",
      key,
      contentType,
      ttl,
    });
    return c.json({
      uploadUrl: url,
      key, // relative key — client should store this in their DB
      expiresInSeconds: ttl,
      expiresAt: new Date(Date.now() + ttl * 1000).toISOString(),
      // Echo what the browser MUST send so a frontend that copy-
      // pastes this can't accidentally use a different content type
      // and break the signature match.
      requiredHeaders: { "Content-Type": contentType },
    });
  },
);

const downloadUrlSchema = z.object({
  /** Relative key — looked up in the project's prefix. */
  key: relativeKeySchema,
  expiresInSeconds: z.number().int().min(1).max(604_800).optional(),
  /**
   * Force download instead of inline display, with the given
   * filename. Set to a string to use that as the saved filename.
   */
  downloadFilename: z.string().trim().max(255).optional(),
});

fileRoutes.post(
  "/download-url",
  zValidator("json", downloadUrlSchema, validationHook),
  (c) => {
    const { key, expiresInSeconds, downloadFilename } = c.req.valid("json");
    if (!isStorageConfigured()) {
      throw new BadRequestError("File storage is not configured on this app");
    }
    const ttl = expiresInSeconds ?? 3600;
    const responseDisposition = downloadFilename
      ? `attachment; filename="${downloadFilename.replace(/"/g, "")}"`
      : undefined;
    const url = getSignedDownloadUrl(key, ttl, { responseDisposition });
    return c.json({
      downloadUrl: url,
      key,
      expiresInSeconds: ttl,
      expiresAt: new Date(Date.now() + ttl * 1000).toISOString(),
    });
  },
);

// ── Server-side proxy upload (small files) ─────────────────────────────────

const PROXY_UPLOAD_MAX_BYTES = 8 * 1024 * 1024; // 8 MB

fileRoutes.post("/upload", async (c) => {
  if (!isStorageConfigured()) {
    throw new BadRequestError("File storage is not configured on this app");
  }
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
  // Run the relative-key shape through the same regex as the JSON
  // routes so multipart callers get the same guarantees.
  const parsed = relativeKeySchema.safeParse(keyField);
  if (!parsed.success) {
    throw new BadRequestError(`key: ${parsed.error.issues[0]?.message ?? "invalid"}`);
  }
  if (file.size > PROXY_UPLOAD_MAX_BYTES) {
    throw new BadRequestError(
      `File exceeds proxy-upload limit (${PROXY_UPLOAD_MAX_BYTES} bytes). ` +
        `Use POST /api/files/upload-url for direct-to-R2 uploads.`,
    );
  }

  const buffer = new Uint8Array(await file.arrayBuffer());
  const result = await putObject({
    key: parsed.data,
    body: buffer,
    contentType: file.type || "application/octet-stream",
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
    url: result.url, // s3://bucket/full-key — store this in your DB
    bytes: buffer.length,
  });
});

// ── Delete ─────────────────────────────────────────────────────────────────

const deleteSchema = z.object({ key: relativeKeySchema });

fileRoutes.delete(
  "/",
  zValidator("json", deleteSchema, validationHook),
  async (c) => {
    if (!isStorageConfigured()) {
      throw new BadRequestError("File storage is not configured on this app");
    }
    const { key } = c.req.valid("json");
    await deleteObject(key);
    log.info("File deleted", {
      source: "files",
      feature: "delete",
      key,
    });
    return c.json({ ok: true, key });
  },
);

export { fileRoutes };
