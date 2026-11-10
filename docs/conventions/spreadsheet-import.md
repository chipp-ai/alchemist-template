# Spreadsheet import

## Spreadsheet import: register an ImportDefinition, never rebuild the wizard

"Let them upload a spreadsheet" is the single most-rebuilt feature in
customer apps, and every rebuild re-derives the same six problems: header
detection, column mapping, per-cell validation, telling a new record apart
from an edit to an existing one, duplicates inside the file, and reporting
honestly on what did not land. **All six are built. When a ticket says
"import our customer list", "bulk upload the roster", "accept their Excel
export", or "let them paste in a CSV", you write ONE registration.** Do not
add a parser, do not write a mapping screen, do not invent an upsert loop.

| Piece | File | What it owns |
|---|---|---|
| Registry | `src/services/import/definitions.ts` | `ImportDefinition`, field specs, derivations, `splitFullName`. |
| Parser | `src/services/import/parse.ts` | CSV + XLSX, header-row detection, one shape out. |
| XLSX guard | `src/utils/xlsx-safe.ts` | The CVE-2023-30533 prototype-pollution guard. ONE copy. |
| Normalizer | `src/services/import/normalize.ts` | Text to typed values, or a named error. |
| Mapper | `src/services/import/mapping.ts` | Header proposal + identity matching. |
| Sessions | `src/services/import/import.service.ts` | The four steps, preview, transactional commit. |
| Table | `import_sessions` (`db/migrations/20260901003427_import_sessions.sql`) | One row per run. |
| Routes | `src/api/routes/imports/index.ts` | `/api/imports/*`. |
| Wizard | `web/src/components/ImportWizard.svelte` | Upload, map, preview, results. |
| Page | `web/src/routes/Import.svelte` (`#/import`) | Picker, wizard, recent runs. |
| Store | `web/src/stores/imports.svelte.ts` | Definitions, sessions, the step calls. |
| **Worked example** | `src/services/import/examples/people.ts` | **Copy this file.** |

```
GET    /api/imports/definitions                    what this app can import
GET    /api/imports/definitions/:name              one, with its field specs
GET    /api/imports/definitions/:name/sample.csv   a starter file
POST   /api/imports/sessions                       JSON {definition, uploadedFileId}
POST   /api/imports/sessions                       or multipart {file, definition}
GET    /api/imports/sessions                       recent runs
GET    /api/imports/sessions/:id                   one session's state
PATCH  /api/imports/sessions/:id/mapping           confirm the mapping
GET    /api/imports/sessions/:id/preview           normalized rows + counts
POST   /api/imports/sessions/:id/commit            run it
```

**Your ONE integration point on the server is a registration**, called from
`main.ts` next to `registerPeopleImport()`:

```ts
registerImportDefinition({
  name: "people",
  label: "People",
  description: "Staff roster: name, email, start date.",
  fields: [
    { key: "fullName", label: "Full name", kind: "text", inputOnly: true,
      aliases: ["employee"] },
    { key: "firstName", label: "First name", kind: "text", required: true },
    { key: "lastName",  label: "Last name",  kind: "text" },
    { key: "email",     label: "Email",      kind: "email", required: true },
    { key: "startDate", label: "Start date", kind: "date", dateOrder: "mdy" },
  ],
  derive: [splitFullName({ from: "fullName", first: "firstName", last: "lastName" })],
  matchBy: [["email"], ["firstName", "lastName"]],
  loadExisting: ({ organizationId }) => /* your SELECT, org-scoped */,
  upsertRow: ({ trx, organizationId, values, existingId }) => /* your write */,
});
```

**And in the UI, one component:**

```svelte
<ImportWizard definition="people" ondone={() => roster.refresh()} />
```

Invariants (each one is a defect somebody already shipped):

- **`matchBy` is what makes a re-import an UPDATE.** Ordered tuples, best
  key first; a tuple only matches when EVERY field in it has a value, so
  half a name pair identifies nobody. An empty `matchBy` means every row is
  a create, which is how a roster doubles on the second upload.
- **`loadExisting` and `upsertRow` MUST org-scope their own queries**
  (CWE-639). Both are handed an `organizationId`; the framework does not
  re-scope the rows you return or the row you write. The route gate is not
  the authorization check.
- **`upsertRow` writes through `trx`, never the module-level `db`.** A
  write on the outer connection does not roll back with the import.
- **The preview and the commit share ONE preparation step**
  (`prepareImport`). A preview that says "12 updates" and a commit that
  creates 12 duplicates is what that sharing makes impossible. Never add a
  second code path that recomputes actions at commit time.
- **The commit is all or nothing, and it is honest about it.** Invalid and
  duplicate rows are excluded BEFORE the transaction and reported as
  skipped with reasons; a failing write rolls everything back, and the
  result marks the failing row failed and every other attempted row not
  imported. A half-applied spreadsheet is worse than none, because you
  cannot tell which half. Identity matching is what makes re-running safe.
- **No row is ever silently dropped.** Every row that does not become a
  record is named in the result with a row number and a reason. Counts
  alone are not a result. The listing is capped at
  `MAX_LISTED_PROBLEM_ROWS` and the leftover is reported as
  `unlistedProblemRows`, never quietly truncated.
- **A value that cannot be read is an ERROR, never a guess or a
  truncation.** `2026-02-30` does not roll into March, an over-long text
  cell is refused rather than cut, and `pending` is not a no. An ambiguous
  numeric date follows the definition's `dateOrder`, because the file
  cannot tell you which it is.
- **An ambiguous column heading is left UNMAPPED**, flagged, with the
  candidates named. Guessing between two equally good answers is how an
  import writes a phone number into an address column.
- **CSV does not go through sheetjs**, which type-guesses and turns the zip
  code `01234` into `1234`. XLSX does, through the shared guard in
  `src/utils/xlsx-safe.ts`. Never add a second copy of that CVE guard.
- **XLSX date cells are read from LOCAL components**, not `toISOString()`:
  sheetjs builds them from local-time parts, so a UTC read moves every date
  back a day east of Greenwich. A `DATE` column read back OUT of Postgres
  is the mirror case: postgres.js parses it to UTC midnight, so read that
  one with `toISOString().slice(0, 10)`, never `String()`.
- **Step one is `<UploadField>`, not a second uploader.** The wizard posts
  no bytes; the picker stores the file on the uploads paved road and the
  wizard opens a session on the file id. The import re-checks the type
  against the definition, because the app-wide allowlist is wider than one
  import's.
- **Authorization is per definition, not per router.** Each declares the
  capability it needs (`app.write` by default) and every route checks it.
  The definitions list is a menu that marks what THIS caller may run, so an
  import is greyed out rather than hidden.
- **Sessions are a table, never memory.** A step's state has to survive a
  deploy and be readable by whichever pod serves the next request. The
  file's rows are not stored: each step re-parses the stored object, so the
  preview and the commit read the same bytes through the same code.
- **`screenRows` is for row checks that need more than a cell** (a typo
  domain, an address already suppressed, a database lookup). Problem rows
  are skipped with the message as the reason, in the preview and the
  result. It runs inside `prepareImport`, so preview and commit agree.
- **`attestation` makes the importer vouch for the file.** A definition
  that sets it cannot commit until the commit body carries `{ attestation:
  { listSource, listSourceDetail, optedIn: true } }`; the statement is
  stored on `import_sessions.attestation` before any write and handed to
  `upsertRow`. The wizard renders the question, the source choices, the
  warning for a list not collected in this app, and the checkbox. The
  contacts import is the reason it exists (next section but one).
