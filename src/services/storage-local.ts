/**
 * Local-disk storage driver -- what makes uploads work with zero config.
 *
 * R2 is the production driver. It needs four env vars the platform
 * injects, and it needs network egress. Neither exists in local dev, in
 * CI, or in the agent-verification sandbox, so for years the honest
 * answer to "does my upload feature work" was "run it in production and
 * see". That is the gap this driver closes: with R2 unconfigured,
 * `storage.service.ts` transparently reads and writes a directory tree
 * instead, and every upload path works end to end.
 *
 * What is deliberately IDENTICAL to R2:
 *
 *   - the key discipline. Both drivers route every key through
 *     `scopedKey()` / `assertOwnedKey()` in storage-keys.ts, so the
 *     tenant prefix applies on disk exactly as it does in the bucket.
 *   - signed URLs. `buildLocalSignedUrl` mints a short-lived,
 *     HMAC-signed URL, and the route that serves it is PUBLIC because
 *     the signature IS the credential. That is the R2 contract, so code
 *     written against one driver does not need a branch for the other.
 *   - the expiry clamp, so a leaked local URL dies as fast as a leaked
 *     presigned one.
 *
 * What is deliberately DIFFERENT:
 *
 *   - the URL is same-origin and root-relative (`/api/storage/local/o?...`)
 *     rather than absolute. Nothing outside this app can serve it, and a
 *     relative URL survives whatever host the sandbox or a proxy gives us.
 *   - the content type is kept in a sidecar file. A directory has no
 *     object metadata, and guessing from the extension would let a file
 *     come back out as a different type than it went in.
 *
 * This driver is NOT a production store. It is per-pod, it has no
 * replication, and the container runtime does not even grant write
 * access (see the Dockerfile's `deno run` flags). If R2 is unconfigured
 * on a real deployment, an upload fails loudly with a message naming
 * both fixes, which is the correct outcome: silently writing customer
 * files onto an ephemeral pod disk would be worse than refusing.
 */

import { Buffer } from "node:buffer";
import { createHmac, timingSafeEqual } from "node:crypto";
import { dirname, resolve, sep } from "node:path";
import { log } from "@/lib/logger.ts";
import { ExternalServiceError, ForbiddenError, NotFoundError } from "@/utils/errors.ts";
import { assertOwnedKey } from "@/services/storage-keys.ts";
import { MAX_UPLOAD_BYTES } from "@/utils/upload-types.ts";

/** Where the public signed-URL route is mounted. Keep in step with app.ts. */
export const LOCAL_SIGNED_URL_PATH = "/api/storage/local/o";

const DEFAULT_ROOT = ".data/storage";

/** Max bytes a signed local PUT will write. Mirrors the product cap. */
export const LOCAL_PUT_MAX_BYTES = MAX_UPLOAD_BYTES;

/** Longest a local signed URL may live, in seconds. Same 7 days as R2. */
const MAX_TTL_SECONDS = 604_800;

// ── Paths ──────────────────────────────────────────────────────────────────

/** Root of the local object tree. Gitignored; safe to delete. */
export function localStorageRoot(): string {
  return Deno.env.get("LOCAL_STORAGE_DIR") ?? DEFAULT_ROOT;
}

function objectsRoot(): string {
  return resolve(localStorageRoot(), "objects");
}

function metaRoot(): string {
  return resolve(localStorageRoot(), "meta");
}

/**
 * Resolve a full key to a path under `rootDir`, and REFUSE anything that
 * escapes it.
 *
 * `scopedKey()` already rejects traversal in relative keys, but a full
 * key arriving on a signed URL never passed through it. This is the
 * containment check that makes the route safe regardless: the resolved
 * absolute path must sit inside the root, or nothing is read or written.
 */
function pathFor(rootDir: string, fullKey: string, suffix = ""): string {
  const root = resolve(rootDir);
  const candidate = resolve(root, `${fullKey}${suffix}`);
  if (candidate !== root && !candidate.startsWith(root + sep)) {
    throw new ForbiddenError("Cross-tenant access forbidden");
  }
  return candidate;
}

interface LocalObjectMeta {
  contentType: string;
  bytes: number;
  writtenAt: string;
}

// ── Read / write / delete ──────────────────────────────────────────────────

export async function writeLocalObject(
  fullKey: string,
  body: Uint8Array,
  contentType: string,
): Promise<void> {
  const objectPath = pathFor(objectsRoot(), fullKey);
  const metaPath = pathFor(metaRoot(), fullKey, ".json");
  const meta: LocalObjectMeta = {
    contentType: contentType || "application/octet-stream",
    bytes: body.length,
    writtenAt: new Date().toISOString(),
  };

  try {
    await Deno.mkdir(dirname(objectPath), { recursive: true });
    await Deno.writeFile(objectPath, body);
    await Deno.mkdir(dirname(metaPath), { recursive: true });
    await Deno.writeTextFile(metaPath, JSON.stringify(meta));
  } catch (err) {
    throw asStorageFailure(err, fullKey, "write");
  }
}

export async function readLocalObject(
  fullKey: string,
): Promise<{ body: Uint8Array; contentType: string }> {
  const objectPath = pathFor(objectsRoot(), fullKey);
  let body: Uint8Array;
  try {
    body = await Deno.readFile(objectPath);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) throw new NotFoundError("File");
    throw asStorageFailure(err, fullKey, "read");
  }
  return { body, contentType: await readLocalContentType(fullKey) };
}

async function readLocalContentType(fullKey: string): Promise<string> {
  const metaPath = pathFor(metaRoot(), fullKey, ".json");
  try {
    const parsed = JSON.parse(await Deno.readTextFile(metaPath)) as Partial<LocalObjectMeta>;
    return parsed.contentType || "application/octet-stream";
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) {
      // A missing sidecar is survivable (the bytes are still there), but
      // it means something wrote the object without going through this
      // module, which is exactly the kind of drift worth surfacing.
      log.warn(
        "Local object metadata is unreadable; falling back to octet-stream",
        { source: "storage", feature: "local-meta", key: fullKey },
        err as Error,
      );
    }
    return "application/octet-stream";
  }
}

/** Idempotent: deleting an object that is already gone is not an error. */
export async function deleteLocalObject(fullKey: string): Promise<void> {
  for (const path of [pathFor(objectsRoot(), fullKey), pathFor(metaRoot(), fullKey, ".json")]) {
    try {
      await Deno.remove(path);
    } catch (err) {
      if (err instanceof Deno.errors.NotFound) continue;
      throw asStorageFailure(err, fullKey, "delete");
    }
  }
}

export async function localObjectExists(fullKey: string): Promise<boolean> {
  try {
    const stat = await Deno.stat(pathFor(objectsRoot(), fullKey));
    return stat.isFile;
  } catch {
    return false;
  }
}

/**
 * A denied write is configuration, not a bug in the caller: either R2
 * belongs on this deployment, or the runtime needs write access. Say
 * both, and say it as a 502 so it is never mistaken for bad user input.
 */
function asStorageFailure(err: unknown, fullKey: string, op: string): Error {
  const denied = err instanceof Deno.errors.PermissionDenied ||
    (err instanceof Error && err.name === "NotCapable");
  log.error(
    "Local storage operation failed",
    { source: "storage", feature: `local-${op}`, key: fullKey, denied },
    err as Error,
  );
  if (denied) {
    return new ExternalServiceError(
      "storage",
      "the local storage driver cannot write to disk. Configure R2 " +
        "(R2_ENDPOINT / R2_BUCKET / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY) for this " +
        "deployment, or run with write access to the storage directory.",
    );
  }
  return err as Error;
}

// ── Signed URLs ────────────────────────────────────────────────────────────

/**
 * Signing key for local URLs.
 *
 * Reuses `JWT_SECRET` when no dedicated secret is set, so a dev machine
 * and the sandbox both get a stable key with nothing to configure, and
 * the same "development-secret" fallback as `api/middleware/auth.ts`
 * rather than a second convention. A per-process random key would be
 * worse: it would invalidate every outstanding URL on restart and break
 * the moment two processes served the same app.
 */
function signingSecret(): string {
  return Deno.env.get("LOCAL_STORAGE_SIGNING_SECRET") ??
    Deno.env.get("JWT_SECRET") ??
    "development-secret";
}

function signatureFor(
  method: "GET" | "PUT",
  fullKey: string,
  expiresAtUnix: number,
  contentType?: string,
  disposition?: string,
): string {
  // Every field that changes what the URL DOES is signed. Leaving the
  // content type out would let a holder of a PUT URL store a file under
  // a type the server never approved.
  const canonical = [
    method,
    fullKey,
    String(expiresAtUnix),
    contentType ?? "",
    disposition ?? "",
  ].join("\n");
  return createHmac("sha256", signingSecret()).update(canonical).digest("hex");
}

export interface LocalSignOptions {
  contentType?: string;
  responseDisposition?: string;
}

/**
 * Mint a same-origin, time-limited URL. Root-relative on purpose: the
 * browser resolves it against whatever host is serving the SPA, which is
 * the only host that can honour it.
 */
export function buildLocalSignedUrl(
  method: "GET" | "PUT",
  fullKey: string,
  expiresInSeconds: number,
  options: LocalSignOptions = {},
): string {
  const ttl = Math.min(Math.max(Math.floor(expiresInSeconds), 1), MAX_TTL_SECONDS);
  const exp = Math.floor(Date.now() / 1000) + ttl;
  const sig = signatureFor(
    method,
    fullKey,
    exp,
    options.contentType,
    options.responseDisposition,
  );

  const params = new URLSearchParams({ key: fullKey, exp: String(exp), sig });
  if (options.contentType) params.set("ct", options.contentType);
  if (options.responseDisposition) params.set("disposition", options.responseDisposition);
  return `${LOCAL_SIGNED_URL_PATH}?${params.toString()}`;
}

export interface VerifiedLocalRequest {
  fullKey: string;
  contentType?: string;
  disposition?: string;
}

/**
 * Verify a signed local URL. Throws ForbiddenError on anything that does
 * not verify, with the SAME message for a bad signature and an unknown
 * key, so a prober cannot use the error text to enumerate objects.
 *
 * Order matters: check the signature before the expiry. An attacker who
 * learns "this signature is fine, it is just old" learns something; one
 * who gets the same refusal either way learns nothing.
 */
export function verifyLocalSignedUrl(
  method: "GET" | "PUT",
  params: URLSearchParams,
): VerifiedLocalRequest {
  const denied = new ForbiddenError("This file link is invalid or has expired.");

  const fullKey = params.get("key") ?? "";
  const sig = params.get("sig") ?? "";
  const exp = Number(params.get("exp"));
  const contentType = params.get("ct") ?? undefined;
  const disposition = params.get("disposition") ?? undefined;

  if (!fullKey || !sig || !Number.isFinite(exp)) throw denied;

  const expected = signatureFor(method, fullKey, exp, contentType, disposition);
  const given = Buffer.from(sig, "hex");
  const wanted = Buffer.from(expected, "hex");
  if (given.length !== wanted.length || !timingSafeEqual(given, wanted)) throw denied;

  if (exp * 1000 <= Date.now()) throw denied;

  // Defence in depth. The signature already binds the key, but if a
  // signing secret is ever shared between two projects (a copied .env is
  // all it takes), the prefix check is what still stops a cross-tenant
  // read. Same refusal text, so it leaks nothing either.
  try {
    assertOwnedKey(fullKey);
  } catch {
    throw denied;
  }

  return { fullKey, contentType, disposition };
}

/**
 * Content types safe to render in the browser tab. Everything else is
 * served as a download, so a file that somehow got past the allowlist
 * cannot execute on this app's origin.
 */
const INLINE_SAFE_CONTENT_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "application/pdf",
]);

export function localContentDisposition(
  contentType: string,
  requested?: string,
): string {
  if (requested) return requested;
  return INLINE_SAFE_CONTENT_TYPES.has(contentType.toLowerCase()) ? "inline" : "attachment";
}
