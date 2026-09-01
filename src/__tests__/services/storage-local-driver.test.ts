/**
 * Local-disk storage driver -- end to end, with no R2 and no network.
 *
 * The promise this driver makes is that an upload works with zero
 * configuration and behaves the way R2 does. So these tests exercise the
 * REAL round trip (write bytes, mint a signed URL, serve it through the
 * actual public route, read the bytes back) rather than mocking a store.
 *
 * The three things worth breaking the build over:
 *
 *   1. the round trip works with every R2 variable unset
 *   2. the tenant prefix applies on disk exactly as it does in a bucket,
 *      so project A cannot read project B's key
 *   3. a signed URL cannot be edited: not the key, not the expiry, not
 *      the content type
 *
 * Env discipline: R2_* and LOCAL_STORAGE_DIR are saved and restored
 * around every case. Test files share a worker process, and one file
 * that sets R2_ENDPOINT (storage.test.ts does, at module load) must not
 * be able to change what this file is testing.
 */

import { assert, assertEquals, assertRejects } from "@std/assert";
import { withLocalStorage, withTestServer } from "../helpers.ts";
import { storageLocalRoutes } from "@/api/routes/storage-local/index.ts";
import {
  deleteObject,
  describeStorageConfig,
  getObject,
  getSignedDownloadUrl,
  getSignedUploadUrl,
  isR2Configured,
  isStorageConfigured,
  objectExists,
  putObject,
  storageDriver,
} from "@/services/storage.service.ts";
import { buildLocalSignedUrl, LOCAL_SIGNED_URL_PATH } from "@/services/storage-local.ts";

/** The shared helper, with the tenant prefix as a positional argument. */
function withLocalDriver(
  prefix: string,
  fn: (ctx: { root: string; setKeyPrefix: (p: string) => void }) => Promise<void> | void,
): Promise<void> {
  return withLocalStorage(fn, { keyPrefix: prefix });
}

const app = withTestServer((a) => {
  a.route("/api/storage/local", storageLocalRoutes);
});

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

// ── Driver selection ───────────────────────────────────────────────────────

Deno.test("driver: falls back to local when R2 is unconfigured", async () => {
  await withLocalDriver("customer-a/", () => {
    assertEquals(isR2Configured(), false);
    assertEquals(storageDriver(), "local");
    // Storage is ALWAYS available. A route must never gate on this.
    assertEquals(isStorageConfigured(), true);
    return Promise.resolve();
  });
});

Deno.test("driver: describeStorageConfig reports local and says it is not durable", async () => {
  await withLocalDriver("customer-a/", ({ root }) => {
    const cfg = describeStorageConfig();
    assertEquals(cfg.driver, "local");
    assertEquals(cfg.durable, false);
    assertEquals(cfg.configured, true);
    assertEquals(cfg.prefix, "customer-a/");
    assertEquals(cfg.localRoot, root);
    return Promise.resolve();
  });
});

// ── Round trip ─────────────────────────────────────────────────────────────

Deno.test("local driver: put, get, delete round trip with no R2 config", async () => {
  await withLocalDriver("customer-a/", async () => {
    const written = await putObject({
      key: "uploads/report.pdf",
      body: bytes("%PDF-1.7 hello"),
      contentType: "application/pdf",
    });

    assertEquals(written.key, "uploads/report.pdf");
    assertEquals(written.fullKey, "customer-a/uploads/report.pdf");
    assertEquals(await objectExists("uploads/report.pdf"), true);

    const read = await getObject("uploads/report.pdf");
    assertEquals(new TextDecoder().decode(read.body), "%PDF-1.7 hello");
    // The content type survives the round trip rather than being guessed
    // back from the extension.
    assertEquals(read.contentType, "application/pdf");

    await deleteObject("uploads/report.pdf");
    assertEquals(await objectExists("uploads/report.pdf"), false);
  });
});

Deno.test("local driver: delete is idempotent", async () => {
  await withLocalDriver("customer-a/", async () => {
    await deleteObject("uploads/never-existed.pdf");
    await deleteObject("uploads/never-existed.pdf");
  });
});

Deno.test("local driver: reading a missing object is a 404, not a crash", async () => {
  await withLocalDriver("customer-a/", async () => {
    const err = await assertRejects(() => getObject("uploads/gone.pdf")) as {
      statusCode?: number;
    };
    assertEquals(err.statusCode, 404);
  });
});

Deno.test("local driver: the tenant prefix lands on disk", async () => {
  await withLocalDriver("customer-a/", async ({ root }) => {
    await putObject({
      key: "uploads/report.pdf",
      body: bytes("x"),
      contentType: "application/pdf",
    });
    // The prefix is a real directory, which is what makes two projects
    // sharing a machine as separate as two projects sharing a bucket.
    const stat = await Deno.stat(`${root}/objects/customer-a/uploads/report.pdf`);
    assert(stat.isFile);
  });
});

// ── Cross-tenant isolation ─────────────────────────────────────────────────

Deno.test("local driver: tenant B cannot read tenant A's object by relative key", async () => {
  // ONE disk, two tenants, the same relative key. This is the shared-
  // bucket situation reproduced on a filesystem.
  await withLocalDriver("customer-a/", async ({ setKeyPrefix }) => {
    await putObject({
      key: "uploads/secret.pdf",
      body: bytes("tenant A only"),
      contentType: "application/pdf",
    });

    setKeyPrefix("customer-b/");
    assertEquals(await objectExists("uploads/secret.pdf"), false);
    await assertRejects(() => getObject("uploads/secret.pdf"));

    // And B cannot climb out of its own prefix to reach A.
    for (const escape of ["../customer-a/uploads/secret.pdf", "/customer-a/uploads/secret.pdf"]) {
      await assertRejects(() => getObject(escape));
    }
  });
});

Deno.test("local driver: a signed URL for another tenant's key is refused", async () => {
  await withLocalDriver("customer-a/", async ({ setKeyPrefix }) => {
    await putObject({ key: "a.pdf", body: bytes("A"), contentType: "application/pdf" });
    // A URL minted while A is the tenant. Both projects share a signing
    // secret here, which a copied .env is all it takes to arrange.
    const urlForA = buildLocalSignedUrl("GET", "customer-a/a.pdf", 300);

    // Serve it while B is the tenant. The signature verifies, so the
    // prefix check is the only thing left standing. It must hold.
    setKeyPrefix("customer-b/");
    const res = await app.request(urlForA);
    assertEquals(res.status, 403);
    await res.body?.cancel();
  });
});

// ── Signed download URLs, served by the real route ─────────────────────────

Deno.test("signed download: the URL is same-origin and serves the bytes", async () => {
  await withLocalDriver("customer-a/", async () => {
    await putObject({
      key: "uploads/logo.png",
      body: bytes("PNGDATA"),
      contentType: "image/png",
    });

    const url = getSignedDownloadUrl("uploads/logo.png", 300);
    assert(
      url.startsWith(`${LOCAL_SIGNED_URL_PATH}?`),
      `expected a same-origin path, got ${url}`,
    );

    const res = await app.request(url);
    assertEquals(res.status, 200);
    assertEquals(res.headers.get("content-type"), "image/png");
    assertEquals(res.headers.get("x-content-type-options"), "nosniff");
    // An image is safe to render in the tab.
    assertEquals(res.headers.get("content-disposition"), "inline");
    assertEquals(await res.text(), "PNGDATA");
  });
});

Deno.test("signed download: a type that is not inline-safe is served as a download", async () => {
  await withLocalDriver("customer-a/", async () => {
    await putObject({
      key: "uploads/rows.csv",
      body: bytes("a,b\n1,2\n"),
      contentType: "text/csv",
    });
    const res = await app.request(getSignedDownloadUrl("uploads/rows.csv", 300));
    assertEquals(res.status, 200);
    assertEquals(res.headers.get("content-disposition"), "attachment");
    await res.body?.cancel();
  });
});

Deno.test("signed download: an explicit filename forces a named download", async () => {
  await withLocalDriver("customer-a/", async () => {
    await putObject({ key: "x.pdf", body: bytes("PDF"), contentType: "application/pdf" });
    const url = getSignedDownloadUrl("x.pdf", 300, {
      responseDisposition: 'attachment; filename="Q3 report.pdf"',
    });
    const res = await app.request(url);
    assertEquals(res.status, 200);
    assertEquals(res.headers.get("content-disposition"), 'attachment; filename="Q3 report.pdf"');
    await res.body?.cancel();
  });
});

Deno.test("signed download: an unsigned request reads nothing", async () => {
  await withLocalDriver("customer-a/", async () => {
    await putObject({ key: "x.pdf", body: bytes("PDF"), contentType: "application/pdf" });
    const res = await app.request(`${LOCAL_SIGNED_URL_PATH}?key=customer-a/x.pdf`);
    assertEquals(res.status, 403);
    await res.body?.cancel();
  });
});

Deno.test("signed download: the key cannot be swapped after signing", async () => {
  await withLocalDriver("customer-a/", async () => {
    await putObject({ key: "mine.pdf", body: bytes("mine"), contentType: "application/pdf" });
    await putObject({ key: "theirs.pdf", body: bytes("theirs"), contentType: "application/pdf" });

    const signed = new URL(getSignedDownloadUrl("mine.pdf", 300), "http://localhost");
    signed.searchParams.set("key", "customer-a/theirs.pdf");

    const res = await app.request(signed.pathname + signed.search);
    assertEquals(res.status, 403);
    await res.body?.cancel();
  });
});

Deno.test("signed download: the expiry cannot be extended after signing", async () => {
  await withLocalDriver("customer-a/", async () => {
    await putObject({ key: "x.pdf", body: bytes("PDF"), contentType: "application/pdf" });
    const signed = new URL(getSignedDownloadUrl("x.pdf", 300), "http://localhost");
    signed.searchParams.set("exp", String(Math.floor(Date.now() / 1000) + 999_999));

    const res = await app.request(signed.pathname + signed.search);
    assertEquals(res.status, 403);
    await res.body?.cancel();
  });
});

Deno.test("signed download: an expired URL is refused", async () => {
  await withLocalDriver("customer-a/", async () => {
    await putObject({ key: "x.pdf", body: bytes("PDF"), contentType: "application/pdf" });
    // A one-second TTL, correctly signed. Only this module can produce a
    // valid signature over an expiry, so waiting it out is the only way
    // to reach the expiry branch, and that is the point.
    const stale = new URL(buildLocalSignedUrl("GET", "customer-a/x.pdf", 1), "http://localhost");
    await new Promise((r) => setTimeout(r, 1100));
    const res = await app.request(stale.pathname + stale.search);
    assertEquals(res.status, 403);
    await res.body?.cancel();
  });
});

Deno.test("signed download: a traversing key with a VALID signature still reads nothing", async () => {
  await withLocalDriver("", async () => {
    // Empty prefix, so assertOwnedKey passes anything: the containment
    // check on the resolved path is the only thing left. It must hold.
    const url = buildLocalSignedUrl("GET", "../../../../etc/passwd", 300);
    const res = await app.request(url);
    assertEquals(res.status, 403);
    await res.body?.cancel();
  });
});

// ── Signed upload URLs ─────────────────────────────────────────────────────

Deno.test("signed upload: the browser PUTs to the URL and the bytes land", async () => {
  await withLocalDriver("customer-a/", async () => {
    const url = getSignedUploadUrl("uploads/new.png", "image/png", 300);
    assert(url.startsWith(`${LOCAL_SIGNED_URL_PATH}?`));

    const put = await app.request(url, {
      method: "PUT",
      headers: { "Content-Type": "image/png" },
      body: bytes("NEWPNG"),
    });
    assertEquals(put.status, 201);
    await put.body?.cancel();

    const read = await getObject("uploads/new.png");
    assertEquals(new TextDecoder().decode(read.body), "NEWPNG");
    assertEquals(read.contentType, "image/png");
  });
});

Deno.test("signed upload: a mismatched Content-Type is refused, exactly like R2", async () => {
  await withLocalDriver("customer-a/", async () => {
    const url = getSignedUploadUrl("uploads/new.png", "image/png", 300);
    const put = await app.request(url, {
      method: "PUT",
      headers: { "Content-Type": "application/pdf" },
      body: bytes("NOTAPNG"),
    });
    assertEquals(put.status, 400);
    await put.body?.cancel();
    assertEquals(await objectExists("uploads/new.png"), false);
  });
});

Deno.test("signed upload: a download URL cannot be reused to write", async () => {
  await withLocalDriver("customer-a/", async () => {
    // The method is part of the signed string, so a GET signature does
    // not authorise a PUT.
    const downloadUrl = getSignedDownloadUrl("uploads/new.png", 300);
    const put = await app.request(downloadUrl, {
      method: "PUT",
      headers: { "Content-Type": "image/png" },
      body: bytes("SNEAKY"),
    });
    assertEquals(put.status, 403);
    await put.body?.cancel();
  });
});

Deno.test("signed upload: an empty body is refused", async () => {
  await withLocalDriver("customer-a/", async () => {
    const url = getSignedUploadUrl("uploads/empty.png", "image/png", 300);
    const put = await app.request(url, {
      method: "PUT",
      headers: { "Content-Type": "image/png" },
      body: new Uint8Array(0),
    });
    assertEquals(put.status, 400);
    await put.body?.cancel();
  });
});

Deno.test("signed upload: getSignedUploadUrl still requires a content type", async () => {
  await withLocalDriver("customer-a/", () => {
    let threw = false;
    try {
      getSignedUploadUrl("uploads/x.png", "");
    } catch {
      threw = true;
    }
    assertEquals(threw, true);
    return Promise.resolve();
  });
});

// ── Route availability ─────────────────────────────────────────────────────

Deno.test("route: the local object route 404s once R2 is configured", async () => {
  await withLocalDriver("customer-a/", async () => {
    await putObject({ key: "x.pdf", body: bytes("PDF"), contentType: "application/pdf" });
    const url = getSignedDownloadUrl("x.pdf", 300);

    // Wire up R2. Nothing points at the local route any more, so it must
    // stop answering rather than sit there as a second read path.
    Deno.env.set("R2_ENDPOINT", "https://example.invalid");
    Deno.env.set("R2_BUCKET", "b");
    Deno.env.set("R2_ACCESS_KEY_ID", "k");
    Deno.env.set("R2_SECRET_ACCESS_KEY", "s");

    const res = await app.request(url);
    assertEquals(res.status, 404);
    await res.body?.cancel();
  });
});
