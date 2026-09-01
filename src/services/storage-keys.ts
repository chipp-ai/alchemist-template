/**
 * Storage key discipline -- shared by every storage driver.
 *
 * The whole fleet shares one R2 bucket and cross-tenant isolation lives
 * in the path layer: every key is prefixed with this project's
 * `R2_KEY_PREFIX` (`customer-${projectId}/`, set by the rollout
 * controller). The LOCAL-disk driver applies the identical rule against
 * a directory tree, so a key that is safe in one driver is safe in the
 * other and switching drivers cannot change who can read what.
 *
 * This module is a leaf on purpose: `storage.service.ts` (R2) and
 * `storage-local.ts` (disk) both import it, and neither imports the
 * other's internals.
 *
 * The prefix is read LAZILY, on every call, rather than captured at
 * module load. Tests set and clear `R2_KEY_PREFIX` around a case, and a
 * module-load capture would freeze whichever value happened to be in the
 * environment when the first test file in a worker imported this.
 */

import { BadRequestError, ForbiddenError } from "@/utils/errors.ts";

/**
 * Per-project key prefix. Empty outside the platform (local dev, the
 * verification sandbox), where the app is the only tenant of its own
 * storage directory.
 */
export function keyPrefix(): string {
  return Deno.env.get("R2_KEY_PREFIX") ?? "";
}

/**
 * Prepend the per-project prefix to a caller-supplied relative key,
 * after validating the relative key for traversal / shape issues.
 * THIS IS THE ONLY ENTRY POINT for keys any driver writes. Caller-
 * supplied keys are treated as untrusted (they may originate from
 * request bodies / URLs).
 *
 * Rejects:
 *   - empty / missing
 *   - leading slash (would defeat the prefix)
 *   - any `..` or `.` segment (path traversal)
 *   - empty segments (double slash)
 *   - backslashes (Windows-style traversal)
 *   - keys longer than 900 chars (S3 hard limit is 1024; leave headroom)
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
  const parts = relativeKey.split("/");
  for (const seg of parts) {
    if (seg === ".." || seg === "." || seg === "") {
      throw new BadRequestError("storage: key contains invalid segment");
    }
    if (seg.includes("\\")) {
      throw new BadRequestError("storage: key contains backslash");
    }
  }
  return `${keyPrefix()}${relativeKey}`;
}

/**
 * Validate that an already-prefixed key (e.g. read from a DB row, or
 * lifted off a signed URL) belongs to THIS project. Throws
 * ForbiddenError otherwise. Use this at every boundary that accepts a
 * full key from outside your own write path.
 */
export function assertOwnedKey(fullKey: string): string {
  if (!fullKey || typeof fullKey !== "string") {
    throw new BadRequestError("storage: missing key");
  }
  const prefix = keyPrefix();
  if (prefix && !fullKey.startsWith(prefix)) {
    throw new ForbiddenError("Cross-tenant access forbidden");
  }
  return fullKey;
}

/**
 * Strip this project's prefix back off a full key, giving the relative
 * key application code and DB rows use. Asserts ownership first.
 */
export function relativeKeyOf(fullKey: string): string {
  return assertOwnedKey(fullKey).slice(keyPrefix().length);
}

// ── Per-organization scoping ───────────────────────────────────────────────
//
// `R2_KEY_PREFIX` separates one PROJECT from another. It says nothing
// about the workspaces INSIDE a project, and a customer app is
// multi-tenant, so a second partition is needed under it.
//
// Two namespaces live below the project prefix, and every object in the
// app belongs to exactly one of them:
//
//   uploads/<orgId>/<uuid><ext>   the managed layer. Every object has a
//                                 row, and that row's own rules decide
//                                 who may read, replace or remove it.
//   org/<orgId>/<caller key>      the raw layer. No row, so the KEY is
//                                 the only thing that can carry the
//                                 tenant, and it does.
//
// Nothing else is writable. A key that names neither is refused.

/** Namespace the managed uploaded-files layer owns. */
export const MANAGED_UPLOAD_PREFIX = "uploads/";

/** Namespace the raw storage routes own. */
export const RAW_ORG_PREFIX = "org/";

/** The managed layer's key for one object. The only place this shape is built. */
export function managedUploadKey(organizationId: string, extension: string): string {
  return `${MANAGED_UPLOAD_PREFIX}${organizationId}/${crypto.randomUUID()}${extension}`;
}

/**
 * Bind a caller-supplied RAW key to one organization.
 *
 * The raw storage routes take a key straight from a request body. That
 * key is the only identifier they have, so without this it names any
 * object in the whole project: another workspace's invoice, or (worse) a
 * managed upload, whose per-file authorization the raw routes never
 * consult. Both were reachable, because the managed layer hands the
 * browser a signed URL with the full key in it, so any member could read
 * a key off their own download URL and edit the org id in it.
 *
 * The rule, applied to every raw key on the way in:
 *
 *   - a key already under `org/<thisOrg>/` passes through unchanged, so
 *     a client can store the key it was given and send it back
 *   - a key under `org/<someone else>/` is FORBIDDEN, not silently
 *     rewritten: the caller asked for a specific object and must be told
 *     no, or they will believe they still have it
 *   - a key under `uploads/` is refused with a pointer at the managed
 *     routes, which is where that object's rules live
 *   - anything else is scoped: `org/<thisOrg>/` is prepended
 *
 * Returns the scoped relative key. Hand THAT to storage.service.ts, and
 * echo it back to the caller so the round trip is stable.
 */
export function orgScopedRawKey(relativeKey: string, organizationId: string): string {
  if (!organizationId) {
    // No tenant means no safe answer. Never fall back to an unscoped key.
    throw new ForbiddenError("Cross-tenant access forbidden");
  }
  // Traversal, backslashes and empty segments are rejected here, BEFORE
  // any prefix reasoning: `org/<thisOrg>/../<otherOrg>/x` must never be
  // read as belonging to this org.
  scopedKey(relativeKey);

  if (relativeKey.startsWith(MANAGED_UPLOAD_PREFIX)) {
    throw new ForbiddenError(
      "That file is a managed upload. Use /api/files/uploads/:id, which applies its review " +
        "status and its owner's permissions.",
    );
  }

  const mine = `${RAW_ORG_PREFIX}${organizationId}/`;
  if (relativeKey.startsWith(mine)) return relativeKey;
  if (relativeKey.startsWith(RAW_ORG_PREFIX)) {
    throw new ForbiddenError("Cross-tenant access forbidden");
  }
  return `${mine}${relativeKey}`;
}
