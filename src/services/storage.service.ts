/**
 * Storage service -- tenant-isolated uploads + signed URLs, on two drivers.
 *
 * Call these helpers and you do not think about which driver is running:
 *
 *   R2     when the platform has injected R2_ENDPOINT / R2_BUCKET /
 *          R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY. The whole customer
 *          fleet shares one bucket and isolation lives in the key prefix
 *          (`R2_KEY_PREFIX`, `customer-${projectId}/`).
 *   LOCAL  otherwise. A gitignored directory tree (`.data/storage`) with
 *          the SAME key discipline and working signed-URL equivalents.
 *          See storage-local.ts. This is what makes uploads work in local
 *          dev, in CI, and in the agent-verification sandbox with no
 *          configuration at all.
 *
 * Because both drivers honour `scopedKey()` / `assertOwnedKey()`, a
 * feature verified locally behaves the same way in production, and
 * nothing in application code branches on the driver. **Do not add an
 * `if (isStorageConfigured())` guard to a new upload path.** Storage is
 * always available now; that guard is what used to make uploads dead on
 * arrival in every environment an agent could actually test in.
 *
 * What this provides:
 *   - putObject()              server-side single-shot upload
 *   - getObject()              server-side fetch (for processing)
 *   - getSignedDownloadUrl()   time-limited GET URL the browser can hit
 *   - getSignedUploadUrl()     time-limited PUT URL for browser direct upload
 *   - deleteObject()           server-side delete
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
import { BadRequestError } from "@/utils/errors.ts";
import { assertOwnedKey, keyPrefix, relativeKeyOf, scopedKey } from "@/services/storage-keys.ts";
import {
  buildLocalSignedUrl,
  deleteLocalObject,
  localObjectExists,
  localStorageRoot,
  readLocalObject,
  writeLocalObject,
} from "@/services/storage-local.ts";

// Re-exported so `@/services/storage.service.ts` stays the one import
// application code needs. The definitions live in storage-keys.ts because
// both drivers depend on them.
export { assertOwnedKey, keyPrefix, relativeKeyOf, scopedKey };

/**
 * Env is read LAZILY on every call, never captured at module load.
 * Tests set and clear these around a case, and a module-load capture
 * would freeze whatever happened to be set when the first test file in a
 * worker imported this module.
 */
const env = (name: string): string => Deno.env.get(name) ?? "";

const REGION = "auto";
const SERVICE = "s3";

export type StorageDriver = "r2" | "local";

/** True when all four R2 credentials are present. */
export function isR2Configured(): boolean {
  return !!(
    env("R2_ENDPOINT") &&
    env("R2_BUCKET") &&
    env("R2_ACCESS_KEY_ID") &&
    env("R2_SECRET_ACCESS_KEY")
  );
}

/** Which driver a call made right now would use. */
export function storageDriver(): StorageDriver {
  return isR2Configured() ? "r2" : "local";
}

/**
 * Whether file storage works at all.
 *
 * Always true: the local driver is the floor. Kept as an exported name
 * because customer apps and older template code call it, but a route
 * should NOT gate on it. Use `isR2Configured()` when you genuinely need
 * to know whether the durable, shared store is behind this app (for
 * example, before telling an operator their files survive a redeploy).
 */
export function isStorageConfigured(): boolean {
  return true;
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
  if (!isR2Configured()) {
    throw new Error(
      "storage: R2 is not configured (R2_ENDPOINT / R2_BUCKET / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY missing)",
    );
  }
  const url = new URL(`${env("R2_ENDPOINT")}/${env("R2_BUCKET")}/${fullKey}`);
  const now = new Date();
  const amzDate = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const dateStamp = amzDate.slice(0, 8);
  return { url, amzDate, dateStamp, host: url.host };
}

function deriveSigningKey(dateStamp: string): Buffer {
  const kDate = hmac(`AWS4${env("R2_SECRET_ACCESS_KEY")}`, dateStamp);
  const kRegion = hmac(kDate, REGION);
  const kService = hmac(kRegion, SERVICE);
  return hmac(kService, "aws4_request");
}

// ── PUT (server-side direct upload) ───────────────────────────────────────

/**
 * Upload a buffer under the project's prefix. Returns the relative key
 * (NOT prefixed) and a canonical `url`. Store the RELATIVE key in your
 * DB row; it is portable across drivers and across a prefix change.
 *
 * The relative key shape is the caller's choice (e.g. `images/abc.jpg`
 * or `users/${userId}/avatar.png`). The service prepends the project
 * prefix, and application code can never escape it.
 */
export async function putObject(opts: {
  key: string;
  body: Uint8Array;
  contentType: string;
}): Promise<{ key: string; fullKey: string; bucket: string; url: string }> {
  const fullKey = scopedKey(opts.key);
  const contentType = opts.contentType || "application/octet-stream";

  if (!isR2Configured()) {
    await writeLocalObject(fullKey, opts.body, contentType);
    return {
      key: opts.key,
      fullKey,
      bucket: "local",
      url: `file://${localStorageRoot()}/objects/${fullKey}`,
    };
  }

  const { url, amzDate, dateStamp, host } = newSignedUrl(fullKey);

  const payloadHash = sha256Hex(opts.body);
  const canonicalUri = canonicalUriFor(url.pathname);
  const canonicalHeaders = `content-type:${contentType}\n` +
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
    `AWS4-HMAC-SHA256 Credential=${env("R2_ACCESS_KEY_ID")}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const res = await fetch(url, {
    method: "PUT",
    headers: {
      "Content-Type": contentType,
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
    bucket: env("R2_BUCKET"),
    url: `s3://${env("R2_BUCKET")}/${fullKey}`,
  };
}

// ── GET (server-side fetch) ────────────────────────────────────────────────

export async function getObject(
  relativeKey: string,
): Promise<{ body: Uint8Array; contentType: string }> {
  const fullKey = scopedKey(relativeKey);

  // The local driver reads the file directly rather than round-tripping
  // through its own HTTP route: there is no server to fetch from during
  // a background job or a test.
  if (!isR2Configured()) return await readLocalObject(fullKey);

  const url = getSignedDownloadUrl(relativeKey, 60);
  const res = await fetch(url);
  if (!res.ok) {
    const text = await res.text().catch(() => "<unreadable>");
    throw new Error(`R2 GET failed: ${res.status} ${text.slice(0, 500)} (key: ${fullKey})`);
  }
  const body = new Uint8Array(await res.arrayBuffer());
  const contentType = res.headers.get("content-type") ?? "application/octet-stream";
  return { body, contentType };
}

/** Whether an object exists. A stat on local; a signed read on R2. */
export async function objectExists(relativeKey: string): Promise<boolean> {
  const fullKey = scopedKey(relativeKey);
  if (!isR2Configured()) return await localObjectExists(fullKey);
  try {
    await getObject(relativeKey);
    return true;
  } catch {
    return false;
  }
}

// ── DELETE ─────────────────────────────────────────────────────────────────

export async function deleteObject(relativeKey: string): Promise<void> {
  const fullKey = scopedKey(relativeKey);

  if (!isR2Configured()) {
    await deleteLocalObject(fullKey);
    return;
  }

  const { url, amzDate, dateStamp, host } = newSignedUrl(fullKey);

  // DELETE has no body; payload hash is the SHA256 of the empty string.
  const emptyHash = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
  const canonicalUri = canonicalUriFor(url.pathname);
  const canonicalHeaders = `host:${host}\n` +
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
    `AWS4-HMAC-SHA256 Credential=${env("R2_ACCESS_KEY_ID")}/${credentialScope}, ` +
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
//   - Download (GET): the browser fetches the file with a time-limited
//     URL and no session cookie. The signature IS the credential.
//   - Upload (PUT):   the browser uploads with a time-limited URL.
//
// On R2 these point at the bucket. On the local driver they point at
// this app's own public `/api/storage/local/o` route. Same contract
// either way, so calling code never branches.

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
    "X-Amz-Credential": `${env("R2_ACCESS_KEY_ID")}/${credentialScope}`,
    "X-Amz-Date": amzDate,
    "X-Amz-Expires": String(expiresInSeconds),
    "X-Amz-SignedHeaders": "host",
  };

  // For presigned GETs we want a content-disposition override on the
  // response; this is signed via the response-content-disposition query
  // param (S3 honors it; R2 also honors it).
  if (method === "GET" && options.responseDisposition) {
    params["response-content-disposition"] = options.responseDisposition;
  }

  // For presigned PUTs we sign a content-type so the browser can't
  // upload arbitrary types under our signature.
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
 * Issue a time-limited GET URL for the given relative key. Use this to
 * serve user-uploaded files without proxying through your server.
 *
 * On R2 the URL is absolute and points at the bucket. On the local
 * driver it is a same-origin, root-relative path served by
 * `/api/storage/local/o`. Both are safe to hand a browser, and neither
 * needs a session cookie.
 *
 * Cross-tenant safety: the relative key is auto-prefixed with this
 * project's R2_KEY_PREFIX.
 */
export function getSignedDownloadUrl(
  relativeKey: string,
  expiresInSeconds = 3600,
  options?: { responseDisposition?: string },
): string {
  const fullKey = scopedKey(relativeKey);
  if (!isR2Configured()) {
    return buildLocalSignedUrl("GET", fullKey, expiresInSeconds, {
      responseDisposition: options?.responseDisposition,
    });
  }
  return presign("GET", fullKey, { expiresInSeconds, ...options });
}

/**
 * Issue a time-limited PUT URL for the given relative key. The browser
 * can upload straight to it without the bytes crossing this server.
 *
 * Caller MUST specify `contentType`. The URL is signed with it, so the
 * browser must send a matching `Content-Type` header. This is what stops
 * anyone holding the URL from storing an arbitrary type under it.
 *
 * Default expiry is 15 min: long enough for a person to drag, drop and
 * finish; short enough that a leaked URL has limited blast radius.
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
  if (!isR2Configured()) {
    return buildLocalSignedUrl("PUT", fullKey, expiresInSeconds, { contentType });
  }
  return presign("PUT", fullKey, { expiresInSeconds, contentType });
}

// ── Diagnostics ────────────────────────────────────────────────────────────

export function describeStorageConfig(): {
  driver: StorageDriver;
  configured: boolean;
  durable: boolean;
  bucket: string;
  prefix: string;
  endpoint: string;
  localRoot: string | null;
} {
  const driver = storageDriver();
  return {
    driver,
    // Storage always works. Kept for callers that read this field.
    configured: true,
    // Whether files survive a pod restart. The honest signal for an
    // operator-facing surface.
    durable: driver === "r2",
    bucket: driver === "r2" ? env("R2_BUCKET") : "local",
    prefix: keyPrefix(),
    endpoint: env("R2_ENDPOINT"),
    localRoot: driver === "local" ? localStorageRoot() : null,
  };
}

// Log config status at import time so a misconfigured pod surfaces
// immediately instead of failing on first upload.
if (keyPrefix() && !keyPrefix().endsWith("/")) {
  log.warn(
    "R2_KEY_PREFIX should end with '/', or auto-prefixed keys may collide with other projects",
    { source: "storage", feature: "config", prefix: keyPrefix() },
  );
}
