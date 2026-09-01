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
