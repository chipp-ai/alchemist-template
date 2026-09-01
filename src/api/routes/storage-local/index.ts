/**
 * Local-driver object routes -- the "presigned URL" endpoint.
 *
 *   GET /api/storage/local/o?key=..&exp=..&sig=..   read one object
 *   PUT /api/storage/local/o?key=..&exp=..&sig=..   write one object
 *
 * These are PUBLIC on purpose. They are the local stand-in for a
 * presigned R2 URL, and a presigned URL carries no cookie: the HMAC
 * signature IS the credential. Adding `requireAuth` here would make the
 * local driver behave differently from R2, which is the one thing this
 * module exists to avoid, and it would break an `<img src>` in any
 * context where the cookie does not ride along.
 *
 * Everything that makes that safe lives in storage-local.ts:
 *   - the signature covers the method, the key, the expiry, the content
 *     type and the disposition, so none of them can be edited in the URL
 *   - it is compared in constant time, and every refusal reads the same
 *   - the key is re-checked against this project's prefix
 *   - the resolved path is re-checked for containment inside the storage
 *     root, so a signature over a traversing key still reads nothing
 *
 * The route only exists while the local driver is active. With R2
 * configured it 404s, because nothing should ever be pointing at it.
 */

import { Hono } from "hono";
import { log } from "@/lib/logger.ts";
import { BadRequestError, NotFoundError } from "@/utils/errors.ts";
import { isR2Configured } from "@/services/storage.service.ts";
import {
  LOCAL_PUT_MAX_BYTES,
  localContentDisposition,
  readLocalObject,
  verifyLocalSignedUrl,
  writeLocalObject,
} from "@/services/storage-local.ts";

const storageLocalRoutes = new Hono();

/**
 * With R2 configured, no signed URL this app mints points here. Serving
 * the route anyway would leave a second, differently-gated read path on
 * a production deployment for no reason.
 */
function assertLocalDriver(): void {
  if (isR2Configured()) throw new NotFoundError("Route");
}

function searchParams(url: string): URLSearchParams {
  return new URL(url).searchParams;
}

// ── GET: read an object ────────────────────────────────────────────────────

storageLocalRoutes.get("/o", async (c) => {
  assertLocalDriver();
  const { fullKey, disposition } = verifyLocalSignedUrl("GET", searchParams(c.req.url));
  const { body, contentType } = await readLocalObject(fullKey);

  // Cast: Deno's lib.dom.d.ts does not list Uint8Array in BodyInit,
  // ArrayBuffer is. Same bytes either way (mirrors putObject's cast).
  const payload = body.buffer.slice(
    body.byteOffset,
    body.byteOffset + body.byteLength,
  ) as ArrayBuffer;

  return new Response(payload, {
    headers: {
      "Content-Type": contentType,
      "Content-Length": String(body.length),
      "Content-Disposition": localContentDisposition(contentType, disposition),
      // Never let a browser re-interpret an uploaded file as something
      // more dangerous than the type it was stored with.
      "X-Content-Type-Options": "nosniff",
      // The URL is already time-limited, so a private cache is fine and
      // saves a round trip on an image the page shows repeatedly. It must
      // not land in a shared cache: the signature is a credential.
      "Cache-Control": "private, max-age=60",
    },
  });
});

// ── PUT: write an object ───────────────────────────────────────────────────

storageLocalRoutes.put("/o", async (c) => {
  assertLocalDriver();
  const verified = verifyLocalSignedUrl("PUT", searchParams(c.req.url));

  // R2 rejects a PUT whose Content-Type header does not match the one
  // signed into the URL. Mirror that, or a feature that works locally
  // breaks the day the customer's bucket is wired up.
  const sent = (c.req.header("content-type") ?? "").split(";")[0].trim().toLowerCase();
  const signed = (verified.contentType ?? "").toLowerCase();
  if (signed && sent !== signed) {
    throw new BadRequestError(
      `Content-Type must be ${signed} to match the signed upload URL.`,
    );
  }

  const body = new Uint8Array(await c.req.arrayBuffer());
  if (body.length === 0) throw new BadRequestError("The upload body is empty.");
  if (body.length > LOCAL_PUT_MAX_BYTES) {
    // R2 has no such ceiling, but an unbounded write here fills the
    // sandbox's disk. Refuse rather than degrade the whole machine.
    throw new BadRequestError(
      `The upload exceeds the ${LOCAL_PUT_MAX_BYTES} byte limit for this storage driver.`,
    );
  }

  await writeLocalObject(
    verified.fullKey,
    body,
    verified.contentType || "application/octet-stream",
  );

  log.info("Local signed upload stored", {
    source: "storage",
    feature: "local-put",
    key: verified.fullKey,
    bytes: body.length,
  });

  return c.json({ data: { key: verified.fullKey, bytes: body.length } }, 201);
});

// There is deliberately NO signed DELETE route. Deleting is a server-side
// decision (`deleteObject()` writes to the same disk directly), and a
// signed delete URL would have to be signed as something, which in
// practice means a leaked upload URL becomes a destroy capability.

export { storageLocalRoutes };
