---
name: files
description: File storage recipes -- storage.service.ts, the managed upload layer (uploads/), the raw org-scoped layer (org/), presigned URLs, the type allowlist and the cross-tenant key contract. Load when touching storage, uploads or downloads. The DECISION rules (where a file belongs, how to recognize a file requirement, how to honor a customer's namespace) live in the hub CLAUDE.md under "Files: decide, detect, name".
paths:
  - "src/services/storage*.ts"
  - "src/services/uploaded-file.service.ts"
  - "src/utils/upload-types.ts"
  - "src/api/routes/files/**"
  - "web/src/stores/uploads.svelte.ts"
  - "web/src/components/*Upload*"
---

# File storage recipes

Moved verbatim from the hub `CLAUDE.md` on 2026-09-22 so the hub carries the
decision rules and this spoke carries the mechanics. Read the hub section
"Files: decide, detect, name" first; it decides WHETHER and WHERE. This file
is HOW.

## File storage — use `storage.service.ts`, never write to R2 directly

Per-project storage hands the pod a TEMPORARY credential: `R2_SESSION_TOKEN`
(and `R2_SESSION_EXPIRES_AT`) next to the key pair. `storage.service.ts`
sends the token on every request and clamps presigned URLs to the
credential's life; `.alchemist/deployment.yaml` declares
`storage.sessionToken: true` so the platform knows this app can take one.
Never remove that declaration, never read `R2_SESSION_TOKEN` in app code,
and never build an R2 request outside the service: a request without the
token is a 403 the moment the project is on its own bucket.

> **For END-USER uploads, read "File uploads: use the paved road" below
> FIRST.** This section is the storage layer underneath it. Reach for
> `putObject` / `getSignedUploadUrl` directly only for machine-to-machine
> writes, or when a file must go straight to the store without a metadata
> row.

The platform injects shared R2 credentials (`R2_ENDPOINT` /
`R2_BUCKET` / `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY`) plus a
per-customer `R2_KEY_PREFIX` (`customer-${projectId}/`). The whole
fleet shares one bucket; cross-tenant isolation lives in the path
layer. **Every R2 key MUST start with `R2_KEY_PREFIX`.** Don't
write your own R2 helpers — `src/services/storage.service.ts` does
this for you and structurally prevents prefix escape.

**Two drivers, one contract.** With those four variables set, the service
talks to R2. Without them (local dev, CI, the verification sandbox) it
transparently reads and writes a gitignored directory tree
(`.data/storage`, see `src/services/storage-local.ts`) with the SAME
`scopedKey()` / `assertOwnedKey()` discipline and working signed-URL
equivalents served by the public `/api/storage/local/o` route. **Uploads
work with zero configuration, and nothing in application code branches on
the driver.**

Consequences worth knowing:

- **`isStorageConfigured()` is always true now** and a route must NOT gate
  on it. That guard is what used to make an upload feature dead on arrival
  in every environment an agent could actually test in. Use
  `isR2Configured()` when you genuinely need to know whether the durable
  shared store is behind this app, and `describeStorageConfig().durable`
  on an operator-facing surface.
- **The local driver is not a production store.** It is per-pod, it does
  not survive a redeploy, and the container runtime does not grant write
  access. On a real deployment with no R2 an upload fails loudly with a
  message naming both fixes, which is correct: silently writing customer
  files onto an ephemeral pod disk would be worse.
- A local signed URL is root-relative and same-origin
  (`/api/storage/local/o?key=...&exp=...&sig=...`); an R2 one is absolute.
  Both are safe to hand a browser and neither needs a session cookie,
  because the signature IS the credential.

### What's available

```ts
import {
  putObject,                // server-side upload
  getObject,                // server-side fetch
  deleteObject,             // server-side delete
  getSignedDownloadUrl,     // browser-facing read URL (default 1h, max 7d)
  getSignedUploadUrl,       // browser direct PUT URL (default 15m, max 7d)
  isStorageConfigured,
  describeStorageConfig,
  scopedKey,                // utility — auto-prefixes a relative key
  assertOwnedKey,           // utility — validates a stored full key
} from "@/services/storage.service.ts";
```

### Recipe — user uploads an image

```ts
// Server: issue a presigned PUT URL the browser can use directly.
const { uploadUrl, key, expiresAt } = await fetch("/api/files/upload-url", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    key: `users/${user.id}/avatars/${crypto.randomUUID()}.jpg`,
    contentType: "image/jpeg",
  }),
}).then((r) => r.json());

// Browser: PUT the file bytes directly to R2. Server never sees them.
await fetch(uploadUrl, {
  method: "PUT",
  headers: { "Content-Type": "image/jpeg" },
  body: file,
});

// Server: store `key` (RELATIVE — without the prefix) in your DB.
await db.insertInto("app.user_avatars").values({ userId: user.id, key }).execute();
```

### Recipe — serve the image later

```ts
// Server: read the relative key from the DB row, hand back a fresh
// signed URL. The R2_KEY_PREFIX gets prepended in the helper.
const url = getSignedDownloadUrl(row.key, 3600);
return c.json({ avatarUrl: url });
```

### Cross-tenant isolation contract

`scopedKey()` (called by every public helper) **rejects**:
- Empty / missing keys
- Leading slash (would defeat prefix)
- `..` segments (path traversal)
- `.` segments (no-op but suspicious)
- Empty segments (double slash)
- Backslashes (Windows-style traversal)
- Keys longer than 900 chars

Application code passes RELATIVE keys (e.g. `images/foo.jpg`) — the
prefix is invisible to your code and impossible to escape using these
helpers. **Do NOT store the full prefixed key in your DB** — store
the relative key. That way if the prefix scheme ever changes (it
won't, but defensively), your data is portable.

### Per-organization isolation on the raw routes

`R2_KEY_PREFIX` separates one PROJECT from another. It says nothing about
the workspaces INSIDE a project, and a customer app is multi-tenant, so
there is a second partition below it. Two namespaces exist and every
object belongs to exactly one:

| Namespace | Owner | Who decides access |
|---|---|---|
| `uploads/<orgId>/<uuid><ext>` | managed layer | the `uploaded_files` row (status, uploader, `files.review`) |
| `org/<orgId>/<your key>` | raw routes | the key itself |

The raw routes record no row, so **the key is the only thing that can
carry the tenant**, and `orgScopedRawKey()` in
`src/services/storage-keys.ts` binds it on the way in:

- a key you were handed back (`org/<yourOrg>/...`) passes through
  unchanged, so the round trip is stable
- a key naming another workspace is a **403**, never a silent rewrite
- a key under `uploads/` is a **403** pointing at
  `/api/files/uploads/:id`, because that object's rules live on its row
  and these routes cannot see them
- anything else is scoped: `org/<yourOrg>/` is prepended, and the SCOPED
  key is what comes back for you to store

This is not defence in depth, it is the only control on that layer. The
managed layer puts the full storage key inside the signed URL it hands
the browser, so without this any member could read a real key off their
own download, edit the workspace id in it, and read, replace or destroy
another workspace's file (CWE-639). **A new raw storage route MUST call
`orgScopedRawKey()`.** The writing routes (`/upload-url`, `/upload`,
`DELETE /api/files`) also require `app.write`, so a viewer cannot mutate
the store.

### Reading an externally-supplied stored full key

If your DB stores the FULL prefixed key (legacy), validate it with
`assertOwnedKey()` before passing to any helper that accepts a raw
key. This is the only safe way to handle a fully-qualified R2 key
that came from outside your own write path.

### Built-in routes

`POST /api/files/upload-url` — body `{ key, contentType, expiresInSeconds? }`,
returns `{ uploadUrl, key, expiresAt, requiredHeaders }`. Auth required.

`POST /api/files/download-url` — body `{ key, expiresInSeconds?, downloadFilename? }`,
returns `{ downloadUrl, key, expiresAt }`. Auth required. Set
`downloadFilename` to force `Content-Disposition: attachment`.

`POST /api/files/upload` — multipart server-side proxy upload, capped at
`MAX_UPLOAD_BYTES` (20 MB) like every other upload route. Use this for
small files when you don't want browser PUT. Body fields: `file` (the
bytes) + `key` (the relative key string). Needs `app.write`.

`DELETE /api/files` — body `{ key }`. Needs `app.write`. Idempotent.

`GET /api/files/info` — diagnostic; returns `{ driver, durable, bucket,
prefix, localRoot, note }`.

Every `key` on these four routes is bound to the caller's workspace and
comes back scoped. Store the key the route RETURNS, and send that one
back. See "Per-organization isolation on the raw routes" above.

### CORS

For browser direct uploads to work, the R2 bucket needs CORS
configured to accept the customer's app origin. The platform handles
this for `*.adaas.dev` automatically — see chipp-ai/alchemist-ai
`scripts/bootstrap-r2-cors.sh`. For custom domains, the platform
adds the origin to the bucket-level rule when the customer registers
the domain (see `R2 Bucket CORS` in alchemist-ai/CLAUDE.md).

## File uploads: use the paved road

Uploads are a configuration surface, not an example to copy. **When a
ticket says "let people attach a receipt", "let them upload their ID",
"accept a spreadsheet", or "an admin should check the file before we use
it", wire up the pieces below.** Do not add a second allowlist, do not
pick your own storage key, do not add an attachments table, and do not
write another admin screen. All four already exist.

| Piece | File | What it owns |
|---|---|---|
| Allowlist | `src/utils/upload-types.ts` | The ONE accepted-types table + size cap. |
| Client mirror | `web/src/lib/upload-types.ts` | Same table, for first paint. Lint-checked. |
| Service | `src/services/uploaded-file.service.ts` | Store, list, review, delete, who may read. |
| Table | `uploaded_files` (`db/migrations/20260901000537_uploaded_files.sql`) | One row per upload. |
| Routes | `src/api/routes/files/index.ts` | Managed uploads + the review queue. |
| Picker | `web/src/components/UploadField.svelte` | The file input for EVERY upload. |
| Review page | `web/src/routes/ReviewQueue.svelte` (`#/files/review`) | Approve or reject, admin-gated. |
| Store | `web/src/stores/uploads.svelte.ts` | Policy, queue, list, mutations. |

```
POST   /api/files/uploads                   multipart `file` (+ subjectType/subjectId)
GET    /api/files/uploads                   org-scoped, visibility-filtered
GET    /api/files/uploads/:id               metadata
GET    /api/files/uploads/:id/download-url  fresh signed URL, status-gated
DELETE /api/files/uploads/:id               uploader or reviewer
GET    /api/files/review-queue              files.review
POST   /api/files/uploads/:id/approve       files.review
POST   /api/files/uploads/:id/reject        files.review, reason required
GET    /api/files/upload-policy             the allowlist, for the picker
```

**Your ONE integration point in the UI is the component:**

```svelte
<UploadField
  subjectType="expense"
  subjectId={expense.id}
  onuploaded={(file) => attachments.push(file)}
/>
```

**And in a service, one call:**

```ts
const file = await storeUploadedFile({
  organizationId: user.organizationId,
  uploadedByUserId: user.id,
  filename: upload.name,
  contentType: upload.type,
  body: bytes,
  subjectType: "expense",
  subjectId: expense.id,
  allow: ["pdf", "jpeg", "png"], // optional, narrows only
  status: "approved",            // optional, skips the queue
});
```

Invariants (each one is a defect someone already shipped):

- **The allowlist is ONE constant, and it checks BOTH labels.** The
  extension AND the declared content type, and the two must agree, fail
  closed. Either alone is trivially spoofed, so a `.png` that declares
  itself a PDF is refused rather than picked apart. Adding a type is one
  line in `src/utils/upload-types.ts` plus the same line in the web
  mirror; a test fails the build if they drift. Never add a second list.
- **`allow` narrows and can never widen.** It intersects with the table,
  so a route asking for a type that is not there gets nothing.
- **The SERVER picks the storage key** (`uploads/<orgId>/<uuid><ext>`). A
  caller-chosen key is a caller-chosen collision, a caller-chosen probe of
  what else exists, and a caller-chosen filename in someone else's folder.
  The uploader's filename is DISPLAY text on the row, never a path.
- **A new row is `pending_review`,** and an unreviewed file is readable by
  its uploader and a reviewer and by nobody else. Approving opens it to
  the workspace; rejecting closes it again and stores the reason. An app
  with no review step passes `status: "approved"` at store time and never
  opens the screen. **Do not "temporarily" default to approved to make a
  demo simpler**; that default IS the control.
- **Visibility is applied in the WHERE clause**
  (`listVisibleUploadedFiles`), not by filtering a result in a route. A
  filter someone forgets to apply is how a pending file reaches a page it
  should never have reached.
- **Every service query is org-scoped in its WHERE clause** (CWE-639).
  Another workspace's file id is a 404. The route gate is not the
  authorization check.
- **The status gate lives at the route that MINTS the download URL**, not
  in the storage layer. A signed URL is a bearer token nothing can take
  back, so who may hold one is decided before it exists.
- **The raw storage routes enforce the same allowlist** but record no row,
  so a file uploaded that way is invisible to the review queue. Reach for
  them deliberately, not by default. They cannot touch a managed upload:
  a key under `uploads/` is a 403 there, because the review status and the
  uploader's permissions live on the row and the raw layer cannot see
  them. Their own keys are bound to the caller's workspace
  (`orgScopedRawKey()`), and their writes need `app.write`.
- **`files.review` is admin and above**, declared in `src/lib/roles.ts`
  and mirrored in `web/src/lib/permissions.ts`. The client check decides
  which buttons render; the API check is the control.
- **`createQuery` arms its fetch on the first `.data` read, and
  `isLoading` does not arm it.** A page whose loading branch renders
  before anything reads `.data` sits on its skeleton forever. Read
  `void query.data` in `onMount`, as `web/src/routes/ReviewQueue.svelte`
  does.
