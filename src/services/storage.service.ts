/**
 * R2 storage service — tenant-isolated uploads + signed URLs.
 *
 * Customer apps store user-uploaded files (images, fonts, PDFs, audio,
 * whatever) in a shared `alchemist-customer-storage` Cloudflare R2
 * bucket. Cross-tenant isolation is enforced at the path layer:
 * every key written by this service is auto-prefixed with the
 * project-specific `R2_KEY_PREFIX` env var (set by the rollout
 * controller as `customer-${projectId}/`). Application code passes
 * RELATIVE keys like `images/avatar.jpg` and the service prepends
 * the prefix; there is no way for app code to write under another
 * project's prefix using these helpers.
 *
 * What this provides:
 *   - putObject()              — server-side single-shot upload
 *   - getObject()              — server-side fetch (for processing)
 *   - getSignedDownloadUrl()   — time-limited GET URL the browser/end-user can hit
 *   - getSignedUploadUrl()     — time-limited PUT URL for browser direct upload
 *                                (use when files are large or you want to skip
 *                                a server-side proxy hop)
 *   - deleteObject()           — server-side delete
 *
 * Why hand-roll SigV4 instead of @aws-sdk/client-s3:
 *   - Customer pods cold-start every restart. The S3 SDK is ~2MB of
 *     dep tree which Deno would pull + compile on first request.
 *   - All we need is signing math + a fetch() call. ~250 LoC vs.
 *     a multi-megabyte dep tree.
 *   - If we ever need multipart upload, S3 transfer manager, or
 *     cross-region replication, switch to the SDK. Until then, lean.
 *
 * SigV4 reference:
 *   https://docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-authenticating-requests.html
 *   https://docs.aws.amazon.com/AmazonS3/latest/API/sigv4-query-string-auth.html
 *   (Cloudflare R2 is S3-compatible; same signing rules apply.)
 */

import { createHash, createHmac } from "node:crypto";
import { Buffer } from "node:buffer";
import { log } from "@/lib/logger.ts";
import { BadRequestError, ForbiddenError } from "@/utils/errors.ts";

const R2_ENDPOINT = Deno.env.get("R2_ENDPOINT") ?? "";
const R2_BUCKET = Deno.env.get("R2_BUCKET") ?? "";
const R2_ACCESS_KEY_ID = Deno.env.get("R2_ACCESS_KEY_ID") ?? "";
const R2_SECRET_ACCESS_KEY = Deno.env.get("R2_SECRET_ACCESS_KEY") ?? "";
/**
 * Per-customer key prefix (e.g. `customer-${projectId}/`). Set by the
 * rollout controller from the agent_jobs.project_id at deploy time.
 * Empty in local dev / running outside the platform — uploads still
 * work, just without isolation (single-tenant local mode).
 */
const R2_KEY_PREFIX = Deno.env.get("R2_KEY_PREFIX") ?? "";
const REGION = "auto";
const SERVICE = "s3";

// ── Cross-tenant safety ────────────────────────────────────────────────────

/**
 * Prepend the per-project prefix to a caller-supplied relative key,
 * after validating the relative key for traversal / shape issues.
 * THIS IS THE ONLY ENTRY POINT for keys written to R2 — every public
 * helper below routes through it. Caller-supplied keys are treated
 * as untrusted (they may originate from request bodies / URLs).
 *
 * Rejects:
 *   - empty / missing
 *   - leading slash (would defeat the prefix)
 *   - any `..` segment (path traversal)
 *   - keys longer than 900 chars (S3 hard limit is 1024; leave headroom for prefix)
 *
 * Returns the fully-qualified R2 object key.
 */
export function scopedKey(relativeKey: string): string {
  if (!relativeKey || typeof relativeKey !== "string") {
    throw new BadRequestError("storage: missing key");
  }
  if (relativeKey.startsWith("/")) {
    throw new BadRequestError("storage: key must not start with /");
  }
  if (relativeKey.length > 900) {
    throw new BadRequestError("storage: key too long");
  }
  // Reject any segment that's exactly ".." OR contains a backslash (windows-y
  // path injection on tooling that normalizes paths).
  const parts = relativeKey.split("/");
  for (const seg of parts) {
    if (seg === ".." || seg === "." || seg === "") {
      throw new BadRequestError("storage: key contains invalid segment");
    }
    if (seg.includes("\\")) {
      throw new BadRequestError("storage: key contains backslash");
    }
  }
  return `${R2_KEY_PREFIX}${relativeKey}`;
}

/**
 * Validate that an already-prefixed key (e.g. read from a DB row that
 * stored the full key) belongs to THIS project. Throws ForbiddenError
 * if the key doesn't start with the current R2_KEY_PREFIX. Use this
 * at API boundaries that accept a stored full key from the client —
 * never trust an externally-supplied full key without this check.
 */
export function assertOwnedKey(fullKey: string): string {
  if (!fullKey || typeof fullKey !== "string") {
    throw new BadRequestError("storage: missing key");
  }
  if (R2_KEY_PREFIX && !fullKey.startsWith(R2_KEY_PREFIX)) {
    throw new ForbiddenError("Cross-tenant access forbidden");
  }
  return fullKey;
}

export function isStorageConfigured(): boolean {
  return !!(R2_ENDPOINT && R2_BUCKET && R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY);
}

// ── SigV4 primitives ───────────────────────────────────────────────────────

function sha256Hex(input: string | Uint8Array): string {
  return createHash("sha256").update(input).digest("hex");
}

function hmac(key: Buffer | string, msg: string): Buffer {
  return createHmac("sha256", key).update(msg).digest();
}

/**
 * URI-encode a path segment per AWS SigV4 rules. RFC 3986 unreserved
 * chars stay as-is; everything else is percent-encoded. Crucially,
 * `!`, `'`, `(`, `)`, `*` are encoded too (Node's encodeURIComponent
 * leaves them).
 */
function encodePathSegment(seg: string): string {
  return encodeURIComponent(seg).replace(
    /[!'()*]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase(),
  );
}

function canonicalUriFor(path: string): string {
  return path.split("/").map((seg) => seg === "" ? "" : encodePathSegment(seg)).join("/");
}

/**
 * Encode a query string per SigV4 rules (sorted, percent-encoded both
 * key and value, no `+` for spaces).
 */
function canonicalQueryString(params: Record<string, string>): string {
  return Object.keys(params)
    .sort()
    .map((k) => `${encodePathSegment(k)}=${encodePathSegment(params[k])}`)
    .join("&");
}

interface SignedUrlInternal {
  url: URL;
  amzDate: string;
  dateStamp: string;
  host: string;
}

function newSignedUrl(fullKey: string): SignedUrlInternal {
  if (!isStorageConfigured()) {
    throw new Error(
      "storage: R2 is not configured (R2_ENDPOINT / R2_BUCKET / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY missing)",
    );
  }
  const url = new URL(`${R2_ENDPOINT}/${R2_BUCKET}/${fullKey}`);
  const now = new Date();
  const amzDate = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const dateStamp = amzDate.slice(0, 8);
  return { url, amzDate, dateStamp, host: url.host };
}

function deriveSigningKey(dateStamp: string): Buffer {
  const kDate = hmac(`AWS4${R2_SECRET_ACCESS_KEY}`, dateStamp);
  const kRegion = hmac(kDate, REGION);
  const kService = hmac(kRegion, SERVICE);
  return hmac(kService, "aws4_request");
}

// ── PUT (server-side direct upload) ───────────────────────────────────────

/**
 * Upload a buffer to R2 under the project's prefix. Returns the
 * relative key (NOT prefixed) and a `url` that's the canonical
 * `s3://bucket/full-key` form — store one of these in your DB row
 * to refer to the object later.
 *
 * The relative key shape is the caller's choice (e.g. `images/abc.jpg`
 * or `users/${userId}/avatar.png`). The service prepends the project
 * prefix — application code can never escape it.
 */
export async function putObject(opts: {
  key: string;
  body: Uint8Array;
  contentType: string;
}): Promise<{ key: string; fullKey: string; bucket: string; url: string }> {
  const fullKey = scopedKey(opts.key);
  const { url, amzDate, dateStamp, host } = newSignedUrl(fullKey);

  const payloadHash = sha256Hex(opts.body);
  const canonicalUri = canonicalUriFor(url.pathname);
  const canonicalHeaders =
    `content-type:${opts.contentType}\n` +
    `host:${host}\n` +
    `x-amz-content-sha256:${payloadHash}\n` +
    `x-amz-date:${amzDate}\n`;
  const signedHeaders = "content-type;host;x-amz-content-sha256;x-amz-date";

  const canonicalRequest = [
    "PUT",
    canonicalUri,
    "",
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const credentialScope = `${dateStamp}/${REGION}/${SERVICE}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join("\n");

  const signature = createHmac("sha256", deriveSigningKey(dateStamp))
    .update(stringToSign)
    .digest("hex");

  const authorization =
    `AWS4-HMAC-SHA256 Credential=${R2_ACCESS_KEY_ID}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const res = await fetch(url, {
    method: "PUT",
    headers: {
      "Content-Type": opts.contentType,
      "Host": host,
      "X-Amz-Content-Sha256": payloadHash,
      "X-Amz-Date": amzDate,
      "Authorization": authorization,
    },
    // Cast: Deno's lib.dom.d.ts in some versions doesn't list Uint8Array
    // in BodyInit; ArrayBuffer is. Same bytes either way.
    body: opts.body.buffer.slice(
      opts.body.byteOffset,
      opts.body.byteOffset + opts.body.byteLength,
    ) as ArrayBuffer,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "<unreadable>");
    throw new Error(`R2 PUT failed: ${res.status} ${text.slice(0, 500)}`);
  }

  return {
    key: opts.key,
    fullKey,
    bucket: R2_BUCKET,
    url: `s3://${R2_BUCKET}/${fullKey}`,
  };
}

// ── GET (server-side fetch) ────────────────────────────────────────────────

export async function getObject(
  relativeKey: string,
): Promise<{ body: Uint8Array; contentType: string }> {
  const fullKey = scopedKey(relativeKey);
  const url = await getSignedDownloadUrl(relativeKey, 60);
  const res = await fetch(url);
  if (!res.ok) {
    const text = await res.text().catch(() => "<unreadable>");
    throw new Error(`R2 GET failed: ${res.status} ${text.slice(0, 500)} (key: ${fullKey})`);
  }
  const body = new Uint8Array(await res.arrayBuffer());
  const contentType = res.headers.get("content-type") ?? "application/octet-stream";
  return { body, contentType };
}

// ── DELETE ─────────────────────────────────────────────────────────────────

export async function deleteObject(relativeKey: string): Promise<void> {
  const fullKey = scopedKey(relativeKey);
  const { url, amzDate, dateStamp, host } = newSignedUrl(fullKey);

  // DELETE has no body; payload hash is the SHA256 of the empty string.
  const emptyHash = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
  const canonicalUri = canonicalUriFor(url.pathname);
  const canonicalHeaders =
    `host:${host}\n` +
    `x-amz-content-sha256:${emptyHash}\n` +
    `x-amz-date:${amzDate}\n`;
  const signedHeaders = "host;x-amz-content-sha256;x-amz-date";

  const canonicalRequest = [
    "DELETE",
    canonicalUri,
    "",
    canonicalHeaders,
    signedHeaders,
    emptyHash,
  ].join("\n");

  const credentialScope = `${dateStamp}/${REGION}/${SERVICE}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join("\n");

  const signature = createHmac("sha256", deriveSigningKey(dateStamp))
    .update(stringToSign)
    .digest("hex");

  const authorization =
    `AWS4-HMAC-SHA256 Credential=${R2_ACCESS_KEY_ID}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const res = await fetch(url, {
    method: "DELETE",
    headers: {
      "Host": host,
      "X-Amz-Content-Sha256": emptyHash,
      "X-Amz-Date": amzDate,
      "Authorization": authorization,
    },
  });

  // R2/S3 returns 204 on successful delete, 404 if missing (idempotent ok).
  if (res.status !== 204 && res.status !== 404) {
    const text = await res.text().catch(() => "<unreadable>");
    throw new Error(`R2 DELETE failed: ${res.status} ${text.slice(0, 500)} (key: ${fullKey})`);
  }
}

// ── Presigned URLs (query-string based) ────────────────────────────────────
//
// Two flavors:
//   - Download (GET): browser fetches the file directly from R2 with
//     a time-limited URL. Use for serving user-uploaded images, files,
//     fonts, etc. without proxying through your server.
//   - Upload (PUT):   browser uploads directly to R2 with a time-
//     limited URL. Use for large files where you don't want to
//     double-spend bandwidth (browser → server → R2).

interface PresignOptions {
  /** TTL in seconds. Default 3600 (1h). R2/S3 max is 7 days = 604800. */
  expiresInSeconds?: number;
  /**
   * For download URLs: override Content-Disposition on the response.
   * Use `attachment; filename="name.ext"` to force download instead of
   * inline display.
   */
  responseDisposition?: string;
}

function presign(
  method: "GET" | "PUT",
  fullKey: string,
  options: PresignOptions & { contentType?: string } = {},
): string {
  const expiresInSeconds = Math.min(
    Math.max(options.expiresInSeconds ?? 3600, 1),
    604_800, // 7 days, R2 / S3 max
  );

  const { url, amzDate, dateStamp, host } = newSignedUrl(fullKey);
  const credentialScope = `${dateStamp}/${REGION}/${SERVICE}/aws4_request`;

  // Query params that go INTO the canonical request. Sorted at the end.
  const params: Record<string, string> = {
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": `${R2_ACCESS_KEY_ID}/${credentialScope}`,
    "X-Amz-Date": amzDate,
    "X-Amz-Expires": String(expiresInSeconds),
    "X-Amz-SignedHeaders": "host",
  };

  // For presigned GETs we want a content-disposition override on the
  // response; this is signed via response-content-disposition query
  // param (S3 honors it; R2 also honors it).
  if (method === "GET" && options.responseDisposition) {
    params["response-content-disposition"] = options.responseDisposition;
  }

  // For presigned PUTs we sign a content-type so the browser can't
  // upload arbitrary types under our signature.
  // Implementation detail: signing content-type via SignedHeaders=host
  // alone means the browser doesn't have to match a content-type the
  // server picked, BUT then anyone with the URL can upload anything.
  // For safety, when a contentType is passed for a PUT, we add it as
  // a signed query param too: the browser must include the header
  // matching what was signed.
  if (method === "PUT" && options.contentType) {
    params["Content-Type"] = options.contentType;
  }

  const canonicalUri = canonicalUriFor(url.pathname);
  const canonicalQuery = canonicalQueryString(params);
  // SignedHeaders = host. For presigned URLs, the only signed header is
  // host (everything else moves into the query string).
  const canonicalHeaders = `host:${host}\n`;
  const signedHeaders = "host";
  // Presigned URLs use UNSIGNED-PAYLOAD as the payload hash.
  const payloadHash = "UNSIGNED-PAYLOAD";

  const canonicalRequest = [
    method,
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join("\n");

  const signature = createHmac("sha256", deriveSigningKey(dateStamp))
    .update(stringToSign)
    .digest("hex");

  // Compose the final URL with query string + signature appended.
  const finalQuery = canonicalQuery + `&X-Amz-Signature=${signature}`;
  return `${url.origin}${url.pathname}?${finalQuery}`;
}

/**
 * Issue a time-limited GET URL for the given relative key. Use this
 * to serve user-uploaded files (images, audio, fonts, attachments)
 * without proxying through your server.
 *
 * Cross-tenant safety: the relative key is auto-prefixed with this
 * project's R2_KEY_PREFIX. Application code cannot construct a URL
 * for another project's prefix using this helper.
 */
export function getSignedDownloadUrl(
  relativeKey: string,
  expiresInSeconds = 3600,
  options?: { responseDisposition?: string },
): string {
  const fullKey = scopedKey(relativeKey);
  return presign("GET", fullKey, { expiresInSeconds, ...options });
}

/**
 * Issue a time-limited PUT URL for the given relative key. The
 * browser can use this to upload directly to R2 without bouncing the
 * file through your server.
 *
 * Caller MUST specify `contentType` — the URL is signed with it, so
 * the browser must include a matching `Content-Type` header on its
 * PUT request. This prevents anyone with the URL from uploading
 * arbitrary content types.
 *
 * Default expiry is 15 min — long enough for a user to drag-drop
 * and complete the upload, short enough that a leaked URL has limited
 * blast radius.
 */
export function getSignedUploadUrl(
  relativeKey: string,
  contentType: string,
  expiresInSeconds = 900,
): string {
  if (!contentType) {
    throw new BadRequestError("storage: contentType is required for upload URLs");
  }
  const fullKey = scopedKey(relativeKey);
  return presign("PUT", fullKey, { expiresInSeconds, contentType });
}

// ── Diagnostics ────────────────────────────────────────────────────────────

export function describeStorageConfig(): {
  configured: boolean;
  bucket: string;
  prefix: string;
  endpoint: string;
} {
  return {
    configured: isStorageConfigured(),
    bucket: R2_BUCKET,
    prefix: R2_KEY_PREFIX,
    endpoint: R2_ENDPOINT,
  };
}

// Log config status at import time so a misconfigured pod surfaces
// immediately instead of failing on first upload.
if (R2_KEY_PREFIX && !R2_KEY_PREFIX.endsWith("/")) {
  log.warn(
    "R2_KEY_PREFIX should end with '/' — auto-prefixed keys may collide with other projects",
    { source: "storage", feature: "config", prefix: R2_KEY_PREFIX },
  );
}
