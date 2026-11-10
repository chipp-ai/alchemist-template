# Files and storage

## Files: decide, detect, name (read before touching storage)

The mechanics (`storage.service.ts`, the managed upload layer, presigned
URLs, the key contract) live in `.claude/rules/files.md` and load when you
touch storage code. This section is the part that has to be in your head
BEFORE that: whether a file belongs in R2 at all, how to notice that a
ticket involves files, and what to do with a hierarchy the customer wants.

### Where a file belongs
- Bytes a person uploads, or will download later: R2, always, with a row.
  Never `bytea`, never base64 in a JSON column, never the repo.
- Generated artifacts someone fetches later (PDF, CSV, export, report,
  thumbnail, rendered image): R2 with a row, even when the app made them.
- Anything binary, or larger than about 1 MB: R2.
- Assets that ship with the app and change only on deploy (the logo in the
  header, fonts, illustrations): the repo's static directory, not R2. If the
  customer will swap them without a deploy, R2 behind a public URL.
- Structured data: Postgres. Store the storage KEY of a file, never its bytes.
- Scratch during a job: `.scratch/`, never R2.

The test: will a human or another system open this later? Then R2.

### How to recognize a file requirement
Treat the ticket or message as involving files when you see any of:
- upload, attach, drag and drop, download, export, import, "send me the file"
- PDF, CSV, spreadsheet, image, photo, avatar, logo, receipt, invoice,
  contract, document, scan, recording, video
- a form with a file input, a "Download" button, an inbound email with an
  attachment, a webhook that delivers a document
- a proposed column named `*_url`, `*_path`, `file`, `attachment`, `image`:
  that is a storage key plus a row, not a URL string
- anything that would put base64 in JSON or bytes in Postgres

Before writing code, state in the plan: which layer (managed `uploads/`,
raw `org/`, or public), the namespace, who may read, and how long it lives.
Review rejects a plan that stores bytes in the database or hand-builds keys.

### Namespaces the customer wants
- Default, when nobody asked: the managed layer via `<UploadField>`. Do not
  invent a folder hierarchy the customer did not ask for.
- When the customer describes a hierarchy ("clients/<name>/contracts/<year>/"),
  honor it verbatim under the raw layer:
  `org/<orgId>/clients/acme/contracts/2026/...`. Still record a row in
  `uploaded_files` so the file is visible to review, search and deletion.
  Keys are RELATIVE; `scopedKey()` adds the project.
- The org segment is not theirs to place and not yours: the helper inserts
  it. Everything below it is the customer's to shape.
- Keep the human filename in the row (`filename`), not in the key. Keys use
  a uuid or a collision-safe slug.
- If the hierarchy is ambiguous, ask exactly one question: who should see
  these (people in the same organization, everyone in the app, or the
  public)? That answer picks the layer. Never ask which storage technology
  to use.
- Never: name a bucket, build a key with the project prefix, touch another
  project's keys, write to `uploads/` by hand, or make a user-visible path
  the security boundary.

## File storage and uploads: mechanics moved to `.claude/rules/files.md`

The two sections that used to live here ("File storage: use
`storage.service.ts`, never write to R2 directly" and "File uploads: use the
paved road") moved verbatim to `.claude/rules/files.md` on 2026-09-22. They
load automatically when you touch storage, upload or download code.
