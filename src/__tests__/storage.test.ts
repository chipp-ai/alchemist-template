/**
 * Storage service tests — cross-tenant isolation contract.
 *
 * The security-critical surface here is `scopedKey()` and
 * `assertOwnedKey()`: every key written to / read from R2 must be
 * confined to this project's R2_KEY_PREFIX. The signing math is
 * the standard SigV4 — Cloudflare's R2 endpoint is the integration
 * test for that, not unit tests.
 *
 * What we DO unit-test here:
 *   1. scopedKey() rejects every shape that could escape the prefix
 *   2. scopedKey() prepends R2_KEY_PREFIX to legitimate keys
 *   3. assertOwnedKey() blocks a key from a different project
 *   4. presigned-URL helpers refuse to run when storage is unconfigured
 *      (defense-in-depth — should never hit prod, but agent-authored
 *      code might forget the env-var guard)
 *
 * No network calls. No real R2.
 */

import { assertEquals, assertThrows } from "@std/assert";

// We import inside an env-setup wrapper so the module-level R2_*
// constants pick up our test values rather than whatever's in the
// shell. The env block must be set BEFORE the dynamic import.
const TEST_PREFIX = "customer-test-project/";

// This file's R2_* mutation is process-wide and (deliberately) never
// restored -- see the module docstring's history. `deno test --parallel`
// runs test FILES as separate isolates that share ONE OS process (and so
// share `Deno.env`, see `src/db/client.ts`'s schema-isolation comment), so
// setting these here at module load can race a concurrent `withLocalStorage`
// call (`src/__tests__/helpers.ts`) in another file's isolate, stomping its
// LOCAL_STORAGE_DIR mid-flight (ALCHEM7-5). Hold the SAME advisory lock
// `withLocalStorage` uses, for this whole file's run, so the two can never
// interleave. Skipped when there's no DB to lock against (e.g. running this
// single file standalone without TEST_DATABASE_URL/DATABASE_URL set) --
// with no DB there's also no `--parallel` fleet to race against.
const HAS_DB = !!(Deno.env.get("TEST_DATABASE_URL") || Deno.env.get("DATABASE_URL"));
let releaseStorageEnvLock: (() => Promise<void>) | null = null;
if (HAS_DB) {
  const [{ sql }, { STORAGE_ENV_LOCK_KEY }] = await Promise.all([
    import("@/db/client.ts"),
    import("./helpers.ts"),
  ]);
  const lock = await sql.reserve();
  await lock`SELECT pg_advisory_lock(${STORAGE_ENV_LOCK_KEY})`;
  releaseStorageEnvLock = async () => {
    try {
      await lock`SELECT pg_advisory_unlock(${STORAGE_ENV_LOCK_KEY})`;
    } catch {
      // best-effort -- releasing the connection below still frees the
      // session-scoped lock even if the explicit unlock call fails.
    }
    lock.release();
  };
}

Deno.env.set("R2_ENDPOINT", "https://test.r2.cloudflarestorage.com");
Deno.env.set("R2_BUCKET", "alchemist-customer-storage-test");
Deno.env.set("R2_ACCESS_KEY_ID", "test-access-key");
Deno.env.set("R2_SECRET_ACCESS_KEY", "test-secret");
Deno.env.set("R2_KEY_PREFIX", TEST_PREFIX);

const storage = await import("@/services/storage.service.ts");

// ── scopedKey: legitimate inputs ──────────────────────────────────────────

Deno.test("scopedKey: simple file name", () => {
  assertEquals(storage.scopedKey("avatar.jpg"), `${TEST_PREFIX}avatar.jpg`);
});

Deno.test("scopedKey: nested path", () => {
  assertEquals(
    storage.scopedKey("users/abc123/avatars/main.png"),
    `${TEST_PREFIX}users/abc123/avatars/main.png`,
  );
});

Deno.test("scopedKey: key with allowed special chars", () => {
  // Periods, hyphens, underscores all allowed.
  assertEquals(
    storage.scopedKey("uploads/2026.05.04/file_v1-final.pdf"),
    `${TEST_PREFIX}uploads/2026.05.04/file_v1-final.pdf`,
  );
});

// ── scopedKey: cross-tenant escape attempts ───────────────────────────────

Deno.test("scopedKey: rejects empty key", () => {
  assertThrows(() => storage.scopedKey(""), Error, "missing key");
});

Deno.test("scopedKey: rejects leading slash", () => {
  // A leading slash would defeat the prefix in some downstream tools.
  assertThrows(() => storage.scopedKey("/foo"), Error, "must not start with /");
});

Deno.test("scopedKey: rejects `..` path traversal", () => {
  assertThrows(() => storage.scopedKey("../other-tenant/avatar.jpg"), Error, "invalid segment");
});

Deno.test("scopedKey: rejects `..` in nested path", () => {
  assertThrows(() => storage.scopedKey("users/../../etc/passwd"), Error, "invalid segment");
});

Deno.test("scopedKey: rejects `.` segment", () => {
  assertThrows(() => storage.scopedKey("users/./avatar.jpg"), Error, "invalid segment");
});

Deno.test("scopedKey: rejects empty segment (double slash)", () => {
  assertThrows(() => storage.scopedKey("users//avatar.jpg"), Error, "invalid segment");
});

Deno.test("scopedKey: rejects backslash", () => {
  assertThrows(() => storage.scopedKey("users\\foo.jpg"), Error, "backslash");
});

Deno.test("scopedKey: rejects key over 900 chars", () => {
  const big = "a".repeat(901);
  assertThrows(() => storage.scopedKey(big), Error, "too long");
});

// ── assertOwnedKey: cross-tenant key from DB ───────────────────────────────

Deno.test("assertOwnedKey: passes a key in this project's prefix", () => {
  assertEquals(
    storage.assertOwnedKey(`${TEST_PREFIX}users/abc/file.jpg`),
    `${TEST_PREFIX}users/abc/file.jpg`,
  );
});

Deno.test("assertOwnedKey: rejects a key from a different project", () => {
  assertThrows(
    () => storage.assertOwnedKey("customer-other-project/users/abc/file.jpg"),
    Error,
    "Cross-tenant access forbidden",
  );
});

Deno.test("assertOwnedKey: rejects unprefixed key", () => {
  assertThrows(
    () => storage.assertOwnedKey("users/abc/file.jpg"),
    Error,
    "Cross-tenant access forbidden",
  );
});

Deno.test("assertOwnedKey: rejects empty", () => {
  assertThrows(() => storage.assertOwnedKey(""), Error, "missing key");
});

// ── isStorageConfigured / describeStorageConfig ──────────────────────────

Deno.test("isStorageConfigured: true when all four R2 vars set", () => {
  assertEquals(storage.isStorageConfigured(), true);
});

Deno.test("describeStorageConfig: surfaces bucket + prefix", () => {
  const cfg = storage.describeStorageConfig();
  assertEquals(cfg.configured, true);
  assertEquals(cfg.bucket, "alchemist-customer-storage-test");
  assertEquals(cfg.prefix, TEST_PREFIX);
});

// ── Presigned URL output shape ─────────────────────────────────────────────
//
// We don't validate the SigV4 cryptographic correctness here (R2's
// 200/4xx response is the integration test for that). We DO validate
// that the URL contains the required SigV4 query params + the
// auto-prefixed key in the path.

Deno.test("getSignedDownloadUrl: URL contains prefix + SigV4 params", () => {
  const url = storage.getSignedDownloadUrl("users/abc/avatar.jpg", 3600);
  const parsed = new URL(url);
  // Path must include both the bucket AND the prefixed key.
  assertEquals(
    parsed.pathname.includes("alchemist-customer-storage-test"),
    true,
    `bucket missing from path: ${parsed.pathname}`,
  );
  assertEquals(
    parsed.pathname.includes("customer-test-project/users/abc/avatar.jpg"),
    true,
    `prefixed key missing from path: ${parsed.pathname}`,
  );
  // Required SigV4 query params.
  for (
    const k of [
      "X-Amz-Algorithm",
      "X-Amz-Credential",
      "X-Amz-Date",
      "X-Amz-Expires",
      "X-Amz-SignedHeaders",
      "X-Amz-Signature",
    ]
  ) {
    if (!parsed.searchParams.has(k)) {
      throw new Error(`missing SigV4 query param: ${k}`);
    }
  }
  assertEquals(parsed.searchParams.get("X-Amz-Algorithm"), "AWS4-HMAC-SHA256");
  assertEquals(parsed.searchParams.get("X-Amz-Expires"), "3600");
  assertEquals(parsed.searchParams.get("X-Amz-SignedHeaders"), "host");
});

Deno.test("getSignedDownloadUrl: a space in the key encodes ONCE (%20, never %2520)", () => {
  // Regression: signing built the URL from the raw key (URL parser -> %20) and
  // then re-encoded url.pathname for the canonical URI (%20 -> %2520), so the
  // signature covered a path the request never sent -> R2 403
  // SignatureDoesNotMatch on any key containing a space.
  const url = storage.getSignedDownloadUrl("uploads/Jane Doe/BLS card.pdf", 300);
  const parsed = new URL(url);
  assertEquals(parsed.pathname.includes("%2520"), false, `double-encoded space in ${parsed.pathname}`);
  assertEquals(parsed.pathname.includes("Jane%20Doe"), true, parsed.pathname);
  // The signer must sign the same bytes it sends: re-parsing the URL is a fixed
  // point (no further encoding drift).
  assertEquals(new URL(parsed.toString()).pathname, parsed.pathname);
});

Deno.test("getSignedDownloadUrl: rejects cross-tenant escape in raw key", () => {
  // The `..` segment must be rejected even though the URL itself
  // would otherwise be valid SigV4.
  assertThrows(
    () => storage.getSignedDownloadUrl("../other-project/file.jpg"),
    Error,
    "invalid segment",
  );
});

Deno.test("getSignedDownloadUrl: includes responseDisposition when provided", () => {
  const url = storage.getSignedDownloadUrl(
    "files/report.pdf",
    300,
    { responseDisposition: 'attachment; filename="my report.pdf"' },
  );
  const parsed = new URL(url);
  // The query param goes through encodePathSegment first, so the value
  // is percent-encoded. Decoding must give back the original disposition.
  const got = parsed.searchParams.get("response-content-disposition");
  assertEquals(got, 'attachment; filename="my report.pdf"');
});

Deno.test("getSignedUploadUrl: requires contentType", () => {
  // Empty contentType is the documented runtime guard target.
  assertThrows(
    () => storage.getSignedUploadUrl("upload.bin", ""),
    Error,
    "contentType is required",
  );
});

Deno.test("getSignedUploadUrl: signs Content-Type into the query string", () => {
  const url = storage.getSignedUploadUrl("uploads/foo.png", "image/png", 600);
  const parsed = new URL(url);
  assertEquals(parsed.searchParams.get("Content-Type"), "image/png");
  assertEquals(parsed.searchParams.get("X-Amz-Expires"), "600");
});

// ── Defense-in-depth: TTL clamp ───────────────────────────────────────────

Deno.test("getSignedDownloadUrl: clamps TTL to 7-day max", () => {
  // 30 days requested → 7 days actually signed.
  const url = storage.getSignedDownloadUrl("foo.jpg", 30 * 24 * 3600);
  const parsed = new URL(url);
  assertEquals(parsed.searchParams.get("X-Amz-Expires"), "604800");
});

Deno.test("getSignedDownloadUrl: clamps non-positive TTL to 1s", () => {
  const url = storage.getSignedDownloadUrl("foo.jpg", -10);
  const parsed = new URL(url);
  assertEquals(parsed.searchParams.get("X-Amz-Expires"), "1");
});

// Must stay the LAST test in this file: releases the advisory lock taken
// above so other isolates' `withLocalStorage` calls can proceed. Deno runs a
// file's tests sequentially in declaration order (and runs every test
// regardless of an earlier one's failure), so this always fires last.
Deno.test("release the storage-env lock", async () => {
  await releaseStorageEnvLock?.();
});

// ── Temporary credential: the session token rides on every request ────────
//
// Per-project storage hands the pod a TEMPORARY, bucket-scoped credential
// (chipp-deno: docs/implementation-plans/customer-storage-per-project/
// template-follow-up.md). It is a key pair PLUS `R2_SESSION_TOKEN`; a request
// signed without the token is a 403 at R2. With the variable unset every
// signature must be byte-identical to today's, so a legacy pod is untouched.

function withSessionToken<T>(token: string | null, expiresAt: string | null, fn: () => T): T {
  const prevToken = Deno.env.get("R2_SESSION_TOKEN");
  const prevExp = Deno.env.get("R2_SESSION_EXPIRES_AT");
  if (token === null) Deno.env.delete("R2_SESSION_TOKEN");
  else Deno.env.set("R2_SESSION_TOKEN", token);
  if (expiresAt === null) Deno.env.delete("R2_SESSION_EXPIRES_AT");
  else Deno.env.set("R2_SESSION_EXPIRES_AT", expiresAt);
  try {
    return fn();
  } finally {
    if (prevToken === undefined) Deno.env.delete("R2_SESSION_TOKEN");
    else Deno.env.set("R2_SESSION_TOKEN", prevToken);
    if (prevExp === undefined) Deno.env.delete("R2_SESSION_EXPIRES_AT");
    else Deno.env.set("R2_SESSION_EXPIRES_AT", prevExp);
  }
}

/** Capture the one fetch a header-signed call makes; answer it as R2 would. */
async function captureFetch(status: number, fn: () => Promise<unknown>): Promise<Request> {
  const original = globalThis.fetch;
  let captured: Request | null = null;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    captured = new Request(input, init);
    return Promise.resolve(new Response(null, { status }));
  }) as typeof fetch;
  try {
    await fn();
  } finally {
    globalThis.fetch = original;
  }
  if (!captured) throw new Error("no fetch was made");
  return captured;
}

Deno.test("presign: a session token is a signed query parameter, and it changes the signature", () => {
  const plain = new URL(withSessionToken(null, null, () => storage.getSignedDownloadUrl("a/b.txt", 600)));
  const withA = new URL(withSessionToken("tok-A", null, () => storage.getSignedDownloadUrl("a/b.txt", 600)));
  const withB = new URL(withSessionToken("tok-B", null, () => storage.getSignedDownloadUrl("a/b.txt", 600)));
  assertEquals(plain.searchParams.has("X-Amz-Security-Token"), false);
  assertEquals(withA.searchParams.get("X-Amz-Security-Token"), "tok-A");
  assertEquals(withB.searchParams.get("X-Amz-Security-Token"), "tok-B");
  assertEquals(
    withA.searchParams.get("X-Amz-Signature") === withB.searchParams.get("X-Amz-Signature"),
    false,
    "the token is inside the canonical request, so a different token signs differently",
  );
  assertEquals(withA.searchParams.get("X-Amz-Expires"), "600", "no expiry in the env means no clamp");
});

Deno.test("presign: the URL never outlives the temporary credential", () => {
  const soon = new Date(Date.now() + 120_000).toISOString();
  const url = new URL(withSessionToken("tok", soon, () => storage.getSignedUploadUrl("a/b.txt", "text/plain", 3600)));
  const expires = Number(url.searchParams.get("X-Amz-Expires"));
  assertEquals(expires <= 120 && expires >= 100, true, `clamped to the credential: ${expires}`);
  const legacy = new URL(withSessionToken(null, soon, () => storage.getSignedUploadUrl("a/b.txt", "text/plain", 3600)));
  assertEquals(legacy.searchParams.get("X-Amz-Expires"), "3600", "no token, no clamp");
});

Deno.test("putObject: the session token is sent and named in SignedHeaders; absent, the signature is unchanged", async () => {
  const body = new TextEncoder().encode("hello");
  const withTok = await withSessionToken("tok-put", null, () =>
    captureFetch(200, () => storage.putObject({ key: "t/hello.txt", body, contentType: "text/plain" })));
  assertEquals(withTok.headers.get("X-Amz-Security-Token"), "tok-put");
  assertEquals(
    /SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date;x-amz-security-token,/.test(withTok.headers.get("Authorization") ?? ""),
    true,
    withTok.headers.get("Authorization") ?? "",
  );
  const without = await withSessionToken(null, null, () =>
    captureFetch(200, () => storage.putObject({ key: "t/hello.txt", body, contentType: "text/plain" })));
  assertEquals(without.headers.has("X-Amz-Security-Token"), false);
  assertEquals(
    /SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date,/.test(without.headers.get("Authorization") ?? ""),
    true,
    without.headers.get("Authorization") ?? "",
  );
});

Deno.test("deleteObject: the session token is sent and named in SignedHeaders", async () => {
  const req = await withSessionToken("tok-del", null, () =>
    captureFetch(204, () => storage.deleteObject("t/hello.txt")));
  assertEquals(req.method, "DELETE");
  assertEquals(req.headers.get("X-Amz-Security-Token"), "tok-del");
  assertEquals(
    /SignedHeaders=host;x-amz-content-sha256;x-amz-date;x-amz-security-token,/.test(req.headers.get("Authorization") ?? ""),
    true,
    req.headers.get("Authorization") ?? "",
  );
});

Deno.test("describeStorageConfig: reports whether a session token is in use, never its value", () => {
  const on = withSessionToken("tok-secret", null, () => storage.describeStorageConfig());
  const off = withSessionToken(null, null, () => storage.describeStorageConfig());
  assertEquals(on.sessionToken, true);
  assertEquals(off.sessionToken, false);
  assertEquals(JSON.stringify(on).includes("tok-secret"), false);
});
