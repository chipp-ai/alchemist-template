/**
 * File upload routes, end to end.
 *
 * A real signed-in request goes into a real route, the bytes land on the
 * real local storage driver, a real row comes back, and a real signed
 * URL serves the file again. Nothing here is mocked and nothing here
 * touches a network: this is exactly the flow an agent-verification
 * sandbox runs, with no R2 and no credentials.
 *
 * What the cases pin:
 *
 *   - upload, list, download and delete work with zero storage config
 *   - the allowlist refuses a bad type, a bad extension, a mismatched
 *     pair and an oversized file, on EVERY upload route
 *   - a pending file is not readable by the rest of the workspace
 *   - one workspace cannot see, download, review or delete another's file
 *   - the review queue is admin-gated and its transitions stick
 */

import { assert, assertEquals } from "@std/assert";
import { createIsolatedUser, getTestDb, withLocalStorage, withTestServer } from "../helpers.ts";
import { createSessionToken } from "@/api/middleware/auth.ts";
import { fileRoutes } from "@/api/routes/files/index.ts";
import { storageLocalRoutes } from "@/api/routes/storage-local/index.ts";
import { MAX_UPLOAD_BYTES } from "@/utils/upload-types.ts";

const HAS_DB = !!(Deno.env.get("TEST_DATABASE_URL") || Deno.env.get("DATABASE_URL"));

function dbTest(name: string, fn: () => Promise<void>) {
  Deno.test({ name, ignore: !HAS_DB, sanitizeResources: false, sanitizeOps: false, fn });
}

const app = withTestServer((a) => {
  a.route("/api/files", fileRoutes);
  // The PUBLIC signed-object route, so a download URL can actually be
  // followed rather than merely inspected.
  a.route("/api/storage/local", storageLocalRoutes);
});

// ── Signing in ─────────────────────────────────────────────────────────────
//
// Real session cookies, because `requireAuth` resolves the user from the
// DATABASE: the role a route sees is the role on the row, not one a test
// asserted. Stubbing the session would have made every permission case
// here a test of the stub.

interface Person {
  id: string;
  email: string;
  name: string | null;
  organizationId: string;
  role: string;
  cookie: string;
}

async function signIn(user: {
  id: string;
  email: string;
  name: string | null;
  organizationId: string;
  role: string;
}): Promise<Person> {
  const token = await createSessionToken(user);
  return { ...user, cookie: `session_id=${token}` };
}

let teammateCounter = 0;

/** A second real account inside the SAME workspace. */
async function addTeammate(organizationId: string, role: string): Promise<Person> {
  teammateCounter++;
  const row = await getTestDb()
    .insertInto("users")
    .values({
      email: `teammate-${Date.now().toString(36)}-${teammateCounter}@files.test.local`,
      name: "Teammate",
      role,
      organizationId,
      emailVerified: true,
    })
    .returning(["id", "email", "name", "role", "organizationId"])
    .executeTakeFirstOrThrow();

  return await signIn({
    id: row.id,
    email: row.email,
    name: row.name,
    organizationId: row.organizationId as string,
    role: row.role,
  });
}

// ── Request helpers ────────────────────────────────────────────────────────

function get(person: Person, path: string): Promise<Response> {
  return app.request(path, { headers: { cookie: person.cookie } });
}

function post(person: Person, path: string, body?: BodyInit, json?: unknown): Promise<Response> {
  return app.request(path, {
    method: "POST",
    headers: {
      cookie: person.cookie,
      ...(json !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: json !== undefined ? JSON.stringify(json) : body,
  });
}

function del(person: Person, path: string): Promise<Response> {
  return app.request(path, { method: "DELETE", headers: { cookie: person.cookie } });
}

function uploadForm(
  filename: string,
  contentType: string,
  body: BlobPart = "%PDF-1.7 sample",
  extra: Record<string, string> = {},
): FormData {
  const form = new FormData();
  form.set("file", new File([body], filename, { type: contentType }));
  for (const [k, v] of Object.entries(extra)) form.set(k, v);
  return form;
}

// deno-lint-ignore no-explicit-any
async function body(res: Response): Promise<any> {
  return await res.json();
}

async function drain(res: Response): Promise<void> {
  await res.body?.cancel();
}

// ── The happy path ─────────────────────────────────────────────────────────

dbTest("upload: a file goes in, a pending row comes out, the bytes come back", async () => {
  const ctx = await createIsolatedUser("admin");
  try {
    await withLocalStorage(async () => {
      const person = await signIn({ ...ctx.user, role: "admin" });

      const res = await post(
        person,
        "/api/files/uploads",
        uploadForm("receipt.pdf", "application/pdf", "%PDF receipt bytes"),
      );
      assertEquals(res.status, 201);
      const created = (await body(res)).data;

      assertEquals(created.filename, "receipt.pdf");
      assertEquals(created.contentType, "application/pdf");
      assertEquals(created.status, "pending_review");
      assertEquals(created.uploadedBy, person.id);
      // The storage key is an implementation detail. It must not leak.
      assertEquals(created.storageKey, undefined);

      const urlRes = await get(person, `/api/files/uploads/${created.id}/download-url`);
      assertEquals(urlRes.status, 200);
      const { downloadUrl } = (await body(urlRes)).data;

      // Followed with NO cookie: a signed URL is its own credential.
      const fileRes = await app.request(downloadUrl);
      assertEquals(fileRes.status, 200);
      assertEquals(await fileRes.text(), "%PDF receipt bytes");
    });
  } finally {
    await ctx.cleanup();
  }
});

dbTest("upload: works with no R2 configured at all", async () => {
  const ctx = await createIsolatedUser("admin");
  try {
    await withLocalStorage(async () => {
      // The point of the local driver, stated plainly.
      assertEquals(Deno.env.get("R2_ENDPOINT"), undefined);
      const person = await signIn({ ...ctx.user, role: "admin" });

      const res = await post(
        person,
        "/api/files/uploads",
        uploadForm("scan.png", "image/png", "PNGBYTES"),
      );
      assertEquals(res.status, 201);

      const info = await body(await get(person, "/api/files/info"));
      assertEquals(info.data.driver, "local");
      // And honest about what that costs.
      assertEquals(info.data.durable, false);
    });
  } finally {
    await ctx.cleanup();
  }
});

dbTest("upload: a subject link is stored and filters the list", async () => {
  const ctx = await createIsolatedUser("admin");
  try {
    await withLocalStorage(async () => {
      const person = await signIn({ ...ctx.user, role: "admin" });

      await post(
        person,
        "/api/files/uploads",
        uploadForm("a.pdf", "application/pdf", "A", {
          subjectType: "expense",
          subjectId: "exp-1",
        }),
      );
      await post(person, "/api/files/uploads", uploadForm("b.pdf", "application/pdf", "B"));

      const filtered = await body(
        await get(person, "/api/files/uploads?subjectType=expense&subjectId=exp-1"),
      );
      assertEquals(filtered.data.length, 1);
      assertEquals(filtered.data[0].filename, "a.pdf");
    });
  } finally {
    await ctx.cleanup();
  }
});

// ── The allowlist, on every route ──────────────────────────────────────────

dbTest("allowlist: the managed upload route refuses every bad shape", async () => {
  const ctx = await createIsolatedUser("admin");
  try {
    await withLocalStorage(async () => {
      const person = await signIn({ ...ctx.user, role: "admin" });

      const cases: [string, string, string][] = [
        ["payload.exe", "application/octet-stream", "a disallowed extension"],
        ["page.pdf", "text/html", "a disallowed content type"],
        ["logo.png", "application/pdf", "an extension that contradicts the content type"],
        ["README", "application/pdf", "no extension at all"],
      ];

      for (const [filename, contentType, why] of cases) {
        const res = await post(
          person,
          "/api/files/uploads",
          uploadForm(filename, contentType, "bytes"),
        );
        assertEquals(res.status, 400, `${why} should be a 400`);
        await drain(res);
      }

      // None of them left a row behind.
      const list = await body(await get(person, "/api/files/uploads"));
      assertEquals(list.data, []);
    });
  } finally {
    await ctx.cleanup();
  }
});

dbTest("allowlist: an oversized file is refused and stores nothing", async () => {
  const ctx = await createIsolatedUser("admin");
  try {
    await withLocalStorage(async () => {
      const person = await signIn({ ...ctx.user, role: "admin" });
      const tooBig = new Uint8Array(MAX_UPLOAD_BYTES + 1);

      const res = await post(
        person,
        "/api/files/uploads",
        uploadForm("huge.pdf", "application/pdf", tooBig),
      );
      assertEquals(res.status, 400);
      await drain(res);

      const list = await body(await get(person, "/api/files/uploads"));
      assertEquals(list.data, []);
    });
  } finally {
    await ctx.cleanup();
  }
});

dbTest("allowlist: the raw proxy-upload route enforces the same rules", async () => {
  const ctx = await createIsolatedUser("admin");
  try {
    await withLocalStorage(async () => {
      const person = await signIn({ ...ctx.user, role: "admin" });

      const bad = await post(
        person,
        "/api/files/upload",
        uploadForm("payload.exe", "application/octet-stream", "MZ", { key: "raw/payload.exe" }),
      );
      assertEquals(bad.status, 400);
      await drain(bad);

      const good = await post(
        person,
        "/api/files/upload",
        uploadForm("ok.pdf", "application/pdf", "%PDF", { key: "raw/ok.pdf" }),
      );
      assertEquals(good.status, 200);
      // The key comes back bound to the caller's workspace: the raw
      // layer records no row, so the key is what carries the tenant.
      assertEquals((await body(good)).key, `org/${ctx.org.id}/raw/ok.pdf`);
    });
  } finally {
    await ctx.cleanup();
  }
});

dbTest("allowlist: the presigned-URL route decides the type before minting", async () => {
  const ctx = await createIsolatedUser("admin");
  try {
    await withLocalStorage(async () => {
      const person = await signIn({ ...ctx.user, role: "admin" });

      // A presigned URL is a capability to write. Once it exists nothing
      // can inspect what goes through it, so the type is settled here.
      const disallowed = await post(person, "/api/files/upload-url", undefined, {
        key: "raw/x.exe",
        contentType: "application/octet-stream",
      });
      assertEquals(disallowed.status, 400);
      await drain(disallowed);

      const mismatched = await post(person, "/api/files/upload-url", undefined, {
        key: "raw/x.png",
        contentType: "application/pdf",
      });
      assertEquals(mismatched.status, 400);
      await drain(mismatched);

      const good = await post(person, "/api/files/upload-url", undefined, {
        key: "raw/x.png",
        contentType: "image/png",
      });
      assertEquals(good.status, 200);
      assert((await body(good)).uploadUrl.includes("sig="));
    });
  } finally {
    await ctx.cleanup();
  }
});

dbTest("policy: the browser reads the same allowlist the server enforces", async () => {
  const ctx = await createIsolatedUser("viewer");
  try {
    await withLocalStorage(async () => {
      const person = await signIn({ ...ctx.user, role: "viewer" });
      const policy = (await body(await get(person, "/api/files/upload-policy"))).data;

      assertEquals(policy.maxBytes, MAX_UPLOAD_BYTES);
      assertEquals(policy.types.map((t: { id: string }) => t.id), [
        "pdf",
        "jpeg",
        "png",
        "doc",
        "docx",
        "csv",
        "xlsx",
      ]);
      assert(policy.accept.includes(".pdf"));
      assert(policy.accept.includes("application/pdf"));
    });
  } finally {
    await ctx.cleanup();
  }
});

// ── Visibility of a pending file ───────────────────────────────────────────

dbTest("visibility: a pending file is hidden from the rest of the workspace", async () => {
  const ctx = await createIsolatedUser("member");
  try {
    await withLocalStorage(async () => {
      const uploader = await signIn({ ...ctx.user, role: ctx.user.role });
      const created = (await body(
        await post(
          uploader,
          "/api/files/uploads",
          uploadForm("private.pdf", "application/pdf", "PRIVATE"),
        ),
      )).data;

      // Same workspace, different person, no review capability.
      const colleague = await addTeammate(ctx.org.id, "member");

      const list = await body(await get(colleague, "/api/files/uploads"));
      assertEquals(list.data, [], "an unreviewed file must not appear in a colleague's list");

      const detail = await get(colleague, `/api/files/uploads/${created.id}`);
      assertEquals(detail.status, 403);
      await drain(detail);

      const url = await get(colleague, `/api/files/uploads/${created.id}/download-url`);
      assertEquals(url.status, 403);
      await drain(url);

      // The uploader can always see their own.
      const own = await body(await get(uploader, "/api/files/uploads"));
      assertEquals(own.data.length, 1);
    });
  } finally {
    await ctx.cleanup();
  }
});

dbTest("visibility: approving opens the file to the workspace", async () => {
  const ctx = await createIsolatedUser("admin");
  try {
    await withLocalStorage(async () => {
      const admin = await signIn({ ...ctx.user, role: "admin" });
      const created = (await body(
        await post(
          admin,
          "/api/files/uploads",
          uploadForm("shared.pdf", "application/pdf", "SHARED"),
        ),
      )).data;

      const viewer = await addTeammate(ctx.org.id, "viewer");
      assertEquals((await body(await get(viewer, "/api/files/uploads"))).data, []);

      const approved = await post(admin, `/api/files/uploads/${created.id}/approve`);
      assertEquals(approved.status, 200);
      assertEquals((await body(approved)).data.status, "approved");

      const nowVisible = await body(await get(viewer, "/api/files/uploads"));
      assertEquals(nowVisible.data.length, 1);
      assertEquals(nowVisible.data[0].id, created.id);
    });
  } finally {
    await ctx.cleanup();
  }
});

// ── Cross-tenant isolation ─────────────────────────────────────────────────

dbTest("isolation: workspace B cannot read, download, review or delete A's file", async () => {
  const a = await createIsolatedUser("owner");
  const b = await createIsolatedUser("owner");
  try {
    await withLocalStorage(async () => {
      const personA = await signIn({ ...a.user, role: "owner" });
      const personB = await signIn({ ...b.user, role: "owner" });

      const created = (await body(
        await post(
          personA,
          "/api/files/uploads",
          uploadForm("a-only.pdf", "application/pdf", "A ONLY"),
        ),
      )).data;
      // Approve it, so status is not what hides it. Only the org scope is.
      await post(personA, `/api/files/uploads/${created.id}/approve`);

      for (
        const path of [
          `/api/files/uploads/${created.id}`,
          `/api/files/uploads/${created.id}/download-url`,
        ]
      ) {
        const res = await get(personB, path);
        assertEquals(res.status, 404, `GET ${path} should be a 404 for another workspace`);
        await drain(res);
      }

      const approve = await post(personB, `/api/files/uploads/${created.id}/approve`);
      assertEquals(approve.status, 404);
      await drain(approve);

      const reject = await post(personB, `/api/files/uploads/${created.id}/reject`, undefined, {
        reason: "not mine",
      });
      assertEquals(reject.status, 404);
      await drain(reject);

      const removed = await del(personB, `/api/files/uploads/${created.id}`);
      assertEquals(removed.status, 404);
      await drain(removed);

      assertEquals((await body(await get(personB, "/api/files/uploads"))).data, []);
      // A's file is untouched.
      const still = await body(await get(personA, `/api/files/uploads/${created.id}`));
      assertEquals(still.data.status, "approved");
    });
  } finally {
    await a.cleanup();
    await b.cleanup();
  }
});

dbTest("isolation: a signed URL minted for A's file is refused under B's prefix", async () => {
  const a = await createIsolatedUser("owner");
  try {
    await withLocalStorage(async ({ setKeyPrefix }) => {
      const personA = await signIn({ ...a.user, role: "owner" });
      const created = (await body(
        await post(personA, "/api/files/uploads", uploadForm("a.pdf", "application/pdf", "A")),
      )).data;
      const { downloadUrl } = (await body(
        await get(personA, `/api/files/uploads/${created.id}/download-url`),
      )).data;

      // The signature still verifies; the tenant prefix has moved on.
      setKeyPrefix("customer-b/");
      const res = await app.request(downloadUrl);
      assertEquals(res.status, 403);
      await drain(res);
    }, { keyPrefix: "customer-a/" });
  } finally {
    await a.cleanup();
  }
});

// ── The raw storage layer ──────────────────────────────────────────────────
//
// The raw routes record no row, so the KEY is the only thing carrying
// the tenant. These cases pin that it actually does.
//
// The attack they close is not theoretical: the managed layer puts the
// full storage key inside the signed URL it hands the browser, so any
// member can read a real key off their own download, edit the workspace
// id in it, and aim a raw route at somebody else's file.

dbTest("raw storage: a caller's key is bound to their own workspace", async () => {
  const a = await createIsolatedUser("owner");
  try {
    await withLocalStorage(async () => {
      const personA = await signIn({ ...a.user, role: "owner" });

      const res = await body(
        await post(
          personA,
          "/api/files/upload",
          uploadForm("r.pdf", "application/pdf", "RAW", { key: "invoices/2026/r.pdf" }),
        ),
      );
      // The key comes back scoped, and that is the key the client stores.
      assertEquals(res.key, `org/${a.org.id}/invoices/2026/r.pdf`);

      // Scoping is idempotent, so sending the stored key back round-trips.
      const again = await body(
        await post(personA, "/api/files/download-url", undefined, { key: res.key }),
      );
      assertEquals(again.key, res.key);

      const fetched = await app.request(again.downloadUrl);
      assertEquals(fetched.status, 200);
      assertEquals(await fetched.text(), "RAW");
    });
  } finally {
    await a.cleanup();
  }
});

dbTest("raw storage: workspace B cannot read, replace or delete A's raw object", async () => {
  const a = await createIsolatedUser("owner");
  const b = await createIsolatedUser("owner");
  try {
    await withLocalStorage(async () => {
      const personA = await signIn({ ...a.user, role: "owner" });
      const personB = await signIn({ ...b.user, role: "owner" });

      const stored = await body(
        await post(
          personA,
          "/api/files/upload",
          uploadForm("a.pdf", "application/pdf", "A ONLY", { key: "secret.pdf" }),
        ),
      );
      const aKey = stored.key;
      assertEquals(aKey, `org/${a.org.id}/secret.pdf`);

      // Read.
      const read = await post(personB, "/api/files/download-url", undefined, { key: aKey });
      assertEquals(read.status, 403);
      await drain(read);

      // Presigned write.
      const mint = await post(personB, "/api/files/upload-url", undefined, {
        key: aKey,
        contentType: "application/pdf",
      });
      assertEquals(mint.status, 403);
      await drain(mint);

      // Replace in place.
      const replace = await post(
        personB,
        "/api/files/upload",
        uploadForm("a.pdf", "application/pdf", "REPLACED", { key: aKey }),
      );
      assertEquals(replace.status, 403);
      await drain(replace);

      // Destroy.
      const removed = await app.request("/api/files", {
        method: "DELETE",
        headers: { cookie: personB.cookie, "content-type": "application/json" },
        body: JSON.stringify({ key: aKey }),
      });
      assertEquals(removed.status, 403);
      await drain(removed);

      // A's bytes are exactly as they were.
      const check = await body(
        await post(personA, "/api/files/download-url", undefined, { key: aKey }),
      );
      assertEquals(await (await app.request(check.downloadUrl)).text(), "A ONLY");
    });
  } finally {
    await a.cleanup();
    await b.cleanup();
  }
});

dbTest("raw storage: the managed namespace is refused outright", async () => {
  const a = await createIsolatedUser("owner");
  const b = await createIsolatedUser("owner");
  try {
    await withLocalStorage(async () => {
      const personA = await signIn({ ...a.user, role: "owner" });
      const personB = await signIn({ ...b.user, role: "owner" });

      const created = (await body(
        await post(
          personA,
          "/api/files/uploads",
          uploadForm("managed.pdf", "application/pdf", "MANAGED"),
        ),
      )).data;

      // Exactly what a member reads off their own signed download URL.
      const { downloadUrl } = (await body(
        await get(personA, `/api/files/uploads/${created.id}/download-url`),
      )).data;
      const leakedKey = new URL(downloadUrl, "http://x").searchParams.get("key")!;
      assert(leakedKey.startsWith("uploads/"), `expected a managed key, got ${leakedKey}`);

      // Neither the owner of the file nor anybody else may aim a raw
      // route at it: that object's rules live on its row.
      for (const person of [personA, personB]) {
        const res = await post(person, "/api/files/download-url", undefined, { key: leakedKey });
        assertEquals(res.status, 403);
        await drain(res);

        const gone = await app.request("/api/files", {
          method: "DELETE",
          headers: { cookie: person.cookie, "content-type": "application/json" },
          body: JSON.stringify({ key: leakedKey }),
        });
        assertEquals(gone.status, 403);
        await drain(gone);
      }

      // The managed file is still readable through its own route.
      const still = await get(personA, `/api/files/uploads/${created.id}/download-url`);
      assertEquals(still.status, 200);
      await drain(still);
    });
  } finally {
    await a.cleanup();
    await b.cleanup();
  }
});

dbTest("raw storage: a viewer cannot write or delete", async () => {
  const a = await createIsolatedUser("owner");
  try {
    await withLocalStorage(async () => {
      const viewer = await addTeammate(a.org.id, "viewer");

      const mint = await post(viewer, "/api/files/upload-url", undefined, {
        key: "x.pdf",
        contentType: "application/pdf",
      });
      assertEquals(mint.status, 403);
      await drain(mint);

      const written = await post(
        viewer,
        "/api/files/upload",
        uploadForm("x.pdf", "application/pdf", "V", { key: "x.pdf" }),
      );
      assertEquals(written.status, 403);
      await drain(written);

      const removed = await app.request("/api/files", {
        method: "DELETE",
        headers: { cookie: viewer.cookie, "content-type": "application/json" },
        body: JSON.stringify({ key: "x.pdf" }),
      });
      assertEquals(removed.status, 403);
      await drain(removed);
    });
  } finally {
    await a.cleanup();
  }
});

// ── The review queue ───────────────────────────────────────────────────────

dbTest("review: the queue is admin-gated", async () => {
  const ctx = await createIsolatedUser("member");
  try {
    await withLocalStorage(async () => {
      const editor = await signIn({ ...ctx.user, role: ctx.user.role });
      const created = (await body(
        await post(editor, "/api/files/uploads", uploadForm("mine.pdf", "application/pdf", "MINE")),
      )).data;

      // An editor may upload. Deciding whether a file is fit to be served
      // is an admin call.
      for (const path of ["/api/files/review-queue", "/api/files/review-queue/count"]) {
        const res = await get(editor, path);
        assertEquals(res.status, 403, `${path} should be admin-gated`);
        await drain(res);
      }

      const approve = await post(editor, `/api/files/uploads/${created.id}/approve`);
      assertEquals(approve.status, 403);
      await drain(approve);

      const reject = await post(editor, `/api/files/uploads/${created.id}/reject`, undefined, {
        reason: "I would rather it were not.",
      });
      assertEquals(reject.status, 403);
      await drain(reject);
    });
  } finally {
    await ctx.cleanup();
  }
});

dbTest("review: an admin works the queue and the transitions stick", async () => {
  const ctx = await createIsolatedUser("admin");
  try {
    await withLocalStorage(async () => {
      const admin = await signIn({ ...ctx.user, role: "admin" });

      const first = (await body(
        await post(admin, "/api/files/uploads", uploadForm("one.pdf", "application/pdf", "ONE")),
      )).data;
      const second = (await body(
        await post(admin, "/api/files/uploads", uploadForm("two.pdf", "application/pdf", "TWO")),
      )).data;

      const queue = (await body(await get(admin, "/api/files/review-queue"))).data;
      assertEquals(queue.pendingCount, 2);
      // Oldest first: a queue is worked from the front.
      assertEquals(queue.files.map((f: { id: string }) => f.id), [first.id, second.id]);

      await post(admin, `/api/files/uploads/${first.id}/approve`);

      const rejected = await post(
        admin,
        `/api/files/uploads/${second.id}/reject`,
        undefined,
        { reason: "The second page is missing." },
      );
      assertEquals(rejected.status, 200);
      const rejectedFile = (await body(rejected)).data;
      assertEquals(rejectedFile.status, "rejected");
      assertEquals(rejectedFile.reviewReason, "The second page is missing.");
      assertEquals(rejectedFile.reviewedBy, admin.id);

      const after = (await body(await get(admin, "/api/files/review-queue"))).data;
      assertEquals(after.pendingCount, 0);
      const count = (await body(await get(admin, "/api/files/review-queue/count"))).data;
      assertEquals(count.pendingCount, 0);
    });
  } finally {
    await ctx.cleanup();
  }
});

dbTest("review: a rejection with no reason is refused", async () => {
  const ctx = await createIsolatedUser("admin");
  try {
    await withLocalStorage(async () => {
      const admin = await signIn({ ...ctx.user, role: "admin" });
      const created = (await body(
        await post(admin, "/api/files/uploads", uploadForm("x.pdf", "application/pdf", "X")),
      )).data;

      for (const payload of [{}, { reason: "   " }]) {
        const res = await post(
          admin,
          `/api/files/uploads/${created.id}/reject`,
          undefined,
          payload,
        );
        assertEquals(res.status, 400);
        await drain(res);
      }

      const still = await body(await get(admin, `/api/files/uploads/${created.id}`));
      assertEquals(still.data.status, "pending_review");
    });
  } finally {
    await ctx.cleanup();
  }
});

// ── Deleting ───────────────────────────────────────────────────────────────

dbTest("delete: the uploader may remove their own file, a colleague may not", async () => {
  const ctx = await createIsolatedUser("member");
  try {
    await withLocalStorage(async () => {
      const uploader = await signIn({ ...ctx.user, role: ctx.user.role });
      const created = (await body(
        await post(
          uploader,
          "/api/files/uploads",
          uploadForm("mine.pdf", "application/pdf", "MINE"),
        ),
      )).data;

      const colleague = await addTeammate(ctx.org.id, "member");
      // A colleague cannot even see it, so the refusal is a 403 on the
      // read that precedes the delete.
      const refused = await del(colleague, `/api/files/uploads/${created.id}`);
      assertEquals(refused.status, 403);
      await drain(refused);

      const removed = await del(uploader, `/api/files/uploads/${created.id}`);
      assertEquals(removed.status, 200);

      const gone = await get(uploader, `/api/files/uploads/${created.id}`);
      assertEquals(gone.status, 404);
      await drain(gone);
    });
  } finally {
    await ctx.cleanup();
  }
});

dbTest("delete: a reviewer may remove someone else's file", async () => {
  const ctx = await createIsolatedUser("admin");
  try {
    await withLocalStorage(async () => {
      const admin = await signIn({ ...ctx.user, role: "admin" });
      const contributor = await addTeammate(ctx.org.id, "member");

      const created = (await body(
        await post(
          contributor,
          "/api/files/uploads",
          uploadForm("theirs.pdf", "application/pdf", "THEIRS"),
        ),
      )).data;

      const removed = await del(admin, `/api/files/uploads/${created.id}`);
      assertEquals(removed.status, 200);
    });
  } finally {
    await ctx.cleanup();
  }
});
