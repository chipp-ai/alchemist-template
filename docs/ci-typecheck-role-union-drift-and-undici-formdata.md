# CI fix: stale role union + `FormData`/`undici-types` nominal mismatch

**Status:** shipped (ALCHEM7-6)

## Problem

CI's "Run tests" step runs `deno test --parallel --allow-all src/__tests__/`
**without** `--no-check`, so every test file's full import graph gets
type-checked (see `docs/ci-typecheck-pure-vs-dom-split.md` for the same
root cause on a prior ticket). Merge commit `7b728d1` combined, for the
first time in one tree, test files that had never been type-checked
together. Two independent, unrelated defects surfaced:

**A. Stale `Role` union in a test helper.** `src/__tests__/helpers.ts`'s
`createIsolatedUser(role)` declared `"owner" | "admin" | "member" | "viewer"`.
The canonical `Role` type (`src/lib/roles.ts`) is
`"owner" | "admin" | "editor" | "viewer"` — `member` is a legacy DB-value
synonym for `editor` (see the `auth` rule), never a value callers should
pass to *construct* a test user. Every test file passing `"editor"` (the
correct, current role) failed to type-check against the stale helper.

**B. `FormData` is nominally two different types in this program.**
`src/__tests__/routes/file-uploads.test.ts` and `imports.test.ts` build a
real `new FormData()` (Deno's own ambient WHATWG type — this repo's root
`deno.json` sets `compilerOptions.lib: ["deno.window", "deno.unstable"]`,
no `"dom"`) and hand it to Hono's `app.request(path, init)`. Hono is an npm
package; its `.d.ts` resolves `RequestInit`/`BodyInit`/`Blob`/`FormData`
against `undici-types`, and this repo's dependency graph pulls in **two**
different `undici-types` versions (`6.20.0` and `7.18.2` — see
`deno.lock`). The result: Deno's own `FormData`/`Blob` is structurally
incompatible with the `undici-types@7.18.2` `BodyInit` Hono's types expect
(`TS2322`, e.g. `Blob.bytes()` returns `Promise<Uint8Array<ArrayBufferLike>>`
vs. the expected `Promise<NonSharedUint8Array>`). This is a real,
pre-existing nominal-typing gap, not something introduced by the merge —
it just had never been exercised by a test file passing a literal
`FormData` into `app.request` before.

## Decision

- **A:** fix the helper's role union in place to match `src/lib/roles.ts`
  (`"owner" | "admin" | "editor" | "viewer"`). Also fixed three call sites
  in `file-uploads.test.ts` that were (incorrectly) constructing a test
  user with the legacy `"member"` role instead of `"editor"`.
- **B:** at each call site that builds an `app.request` `init` object
  containing a `FormData` body, assemble the object first and cast it
  `as unknown as Parameters<typeof app.request>[1]` immediately before the
  call — this asserts against Hono's own declared parameter type (whichever
  `undici-types` version it actually resolves to), instead of trying to
  name it, so the assertion can't silently drift out of sync with a future
  Hono/undici bump.

**Rejected alternative:** add `"dom"` to `compilerOptions.lib` so
Deno's globals and `undici-types` unify. Rejected for the same reason
`ci-typecheck-pure-vs-dom-split.md` rejected it — it changes the type-check
surface for the entire server-side graph, not just these two test files.

**Rejected alternative:** dedupe `undici-types` in `deno.lock` to a single
version. Not attempted — it's a transitive dependency of several unrelated
npm packages; pinning it repo-wide is a bigger, riskier change than a
two-call-site cast for a problem that only bites `FormData`-body test
helpers.

## Public contract

No runtime behavior changed — this is test-file-only typing. Any *new*
test helper that puts a literal `FormData` (or another WHATWG body type)
into an `app.request(...)` call's `init` object needs the same
`as unknown as Parameters<typeof app.request>[1]` cast at the call site.

## Gotcha for future contributors

- Never widen `createIsolatedUser`'s role parameter type independently of
  `src/lib/roles.ts`'s `Role` union — they must match exactly, or CI passes
  locally (`--no-check`) and fails only in CI's real type-check.
- A local `deno check <file>` on a single new test file will NOT catch a
  role-union drift caused by a *different* file's helper change — always
  typecheck the actual helper (`src/__tests__/helpers.ts`) together with
  any test file you're editing when you touch role plumbing.
- If a new test needs to POST a `FormData` body through `app.request`, copy
  the cast pattern from `file-uploads.test.ts` / `imports.test.ts` rather
  than typing the `init` object as `BodyInit` — that annotation is exactly
  what triggers the nominal mismatch.
