/**
 * The import wizard, end to end, through the real routes.
 *
 * A real signed-in request uploads a real spreadsheet, the bytes land on
 * the real local storage driver, the real definition writes real rows,
 * and a second upload of the same file updates them instead of adding
 * everybody twice. Nothing is mocked and nothing touches a network:
 * this is exactly what an agent-verification sandbox with no R2 runs.
 *
 * What the cases pin, in the order a customer notices them:
 *
 *   - the mapping screen is already correct for headings nobody has
 *     tidied ("Work E-Mail", "Department")
 *   - the preview says how many creates and how many updates, and it is
 *     telling the truth, because the commit runs the same preparation
 *   - a re-import UPDATES; the table does not grow
 *   - a bad row, a duplicate row and a missing required field are each
 *     named in the result with a reason, never dropped in silence
 *   - a failing write rolls the whole thing back and says so on every row
 *   - one workspace cannot see or commit another's import
 *   - the definition's capability is the gate, on every route
 */

import { assert, assertEquals } from "@std/assert";
import { createIsolatedUser, getTestDb, withLocalStorage, withTestServer } from "../helpers.ts";
import { createSessionToken } from "@/api/middleware/auth.ts";
import { fileRoutes } from "@/api/routes/files/index.ts";
import { importRoutes } from "@/api/routes/imports/index.ts";
import {
  findImportDefinition,
  type ImportDefinition,
  registerImportDefinition,
} from "@/services/import/definitions.ts";
import { registerPeopleImport } from "@/services/import/examples/people.ts";

const HAS_DB = !!(Deno.env.get("TEST_DATABASE_URL") || Deno.env.get("DATABASE_URL"));

function dbTest(name: string, fn: () => Promise<void>) {
  Deno.test({ name, ignore: !HAS_DB, sanitizeResources: false, sanitizeOps: false, fn });
}

const app = withTestServer((a) => {
  a.route("/api/imports", importRoutes);
  // The wizard's real first step is <UploadField> posting here, so the
  // handoff between the two routers is exercised rather than assumed.
  a.route("/api/files", fileRoutes);
});

const FIXTURES = new URL("../fixtures/import/", import.meta.url);

const XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

function fixture(name: string): Uint8Array {
  return Deno.readFileSync(new URL(name, FIXTURES));
}

/**
 * A definition whose write always fails on the third row, so the
 * rollback path is exercised against a real transaction rather than a
 * stub. Registered once per worker; the name is its own.
 */
const FAILING_IMPORT = "test-failing-people";

const failingDefinition: ImportDefinition = {
  name: FAILING_IMPORT,
  label: "Failing people",
  description: "Test-only. Throws on the third row.",
  fields: [
    { key: "firstName", label: "First name", kind: "text", required: true },
    { key: "lastName", label: "Last name", kind: "text" },
    { key: "email", label: "Email", kind: "email", required: true },
  ],
  matchBy: [["email"]],
  loadExisting: () => Promise.resolve([]),
  upsertRow: async ({ trx, organizationId, values, rowNumber }) => {
    if (rowNumber === 3) throw new Error("the third row always fails");
    const inserted = await trx
      .insertInto("import_demo_people")
      .values({
        organizationId,
        firstName: String(values.firstName),
        lastName: values.lastName === null ? null : String(values.lastName),
        email: String(values.email),
      })
      .returning(["id"])
      .executeTakeFirstOrThrow();
    return { id: inserted.id };
  },
};

/**
 * Registration happens per test rather than once at module load. The
 * registry is module state shared by every test file in this worker, and
 * a sibling file that clears it must not be able to leave this one
 * looking at an empty registry. Both calls are idempotent.
 */
function ensureDefinitions(): void {
  registerPeopleImport();
  if (!findImportDefinition(FAILING_IMPORT)) registerImportDefinition(failingDefinition);
}

// ── Signing in ─────────────────────────────────────────────────────────────

interface Person {
  id: string;
  organizationId: string;
  role: string;
  cookie: string;
}

async function signIn(role: "owner" | "admin" | "editor" | "viewer" = "owner"): Promise<
  Person & { cleanup: () => Promise<void> }
> {
  const { user, cleanup } = await createIsolatedUser(role);
  const token = await createSessionToken({
    id: user.id,
    email: user.email,
    name: user.name,
    organizationId: user.organizationId,
    role: user.role,
  });
  return {
    id: user.id,
    organizationId: user.organizationId,
    role: user.role,
    cookie: `session_id=${token}`,
    cleanup,
  };
}

// ── Request helpers ────────────────────────────────────────────────────────

function get(person: Person, path: string): Promise<Response> {
  return app.request(path, { headers: { cookie: person.cookie } });
}

function postJson(person: Person, path: string, body?: unknown): Promise<Response> {
  return app.request(path, {
    method: "POST",
    headers: {
      cookie: person.cookie,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function patchJson(person: Person, path: string, body: unknown): Promise<Response> {
  return app.request(path, {
    method: "PATCH",
    headers: { cookie: person.cookie, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function uploadFile(
  person: Person,
  opts: { definition: string; filename: string; contentType: string; body: Uint8Array },
): Promise<Response> {
  const form = new FormData();
  form.set("file", new File([opts.body], opts.filename, { type: opts.contentType }));
  form.set("definition", opts.definition);
  return app.request("/api/imports/sessions", {
    method: "POST",
    headers: { cookie: person.cookie },
    body: form,
  });
}

// deno-lint-ignore no-explicit-any
async function json(res: Response): Promise<any> {
  return await res.json();
}

/** Upload, accept the proposed mapping, and hand back the session id. */
async function startSession(
  person: Person,
  opts: { definition: string; filename: string; contentType: string; body: Uint8Array },
): Promise<{ id: string; proposal: Array<{ columnIndex: number; fieldKey: string | null }> }> {
  const res = await uploadFile(person, opts);
  assertEquals(res.status, 201, await res.clone().text());
  const body = await json(res);
  return { id: body.data.session.id, proposal: body.data.proposal };
}

async function roster(organizationId: string) {
  return await getTestDb()
    .selectFrom("import_demo_people")
    .selectAll()
    .where("organizationId", "=", organizationId)
    .orderBy("email", "asc")
    .execute();
}

// ── Definitions ────────────────────────────────────────────────────────────

dbTest("the definitions list names what this caller may run", async () => {
  ensureDefinitions();
  const owner = await signIn("owner");
  const viewer = await signIn("viewer");
  try {
    const asOwner = await json(await get(owner, "/api/imports/definitions"));
    // deno-lint-ignore no-explicit-any
    const people = asOwner.data.find((d: any) => d.name === "people");
    assert(people, "the people example should be registered");
    assertEquals(people.canRun, true);
    assertEquals(people.capability, "app.write");
    // The field specs travel to the client so the wizard can build its
    // dropdowns without a second call.
    // deno-lint-ignore no-explicit-any
    assert(people.fields.some((f: any) => f.key === "email" && f.required));

    const asViewer = await json(await get(viewer, "/api/imports/definitions"));
    // deno-lint-ignore no-explicit-any
    const forViewer = asViewer.data.find((d: any) => d.name === "people");
    // Listed and greyed out, not hidden: a person who cannot see the
    // import at all just files a support ticket asking where it went.
    assertEquals(forViewer.canRun, false);
  } finally {
    await owner.cleanup();
    await viewer.cleanup();
  }
});

dbTest("a starter file carries the exact headings the mapper wants", async () => {
  ensureDefinitions();
  const owner = await signIn();
  try {
    const res = await get(owner, "/api/imports/definitions/people/sample.csv");
    assertEquals(res.status, 200);
    const text = await res.text();
    assert(text.startsWith("Full Name,Work E-Mail"), text.slice(0, 60));
  } finally {
    await owner.cleanup();
  }
});

// ── The whole flow ─────────────────────────────────────────────────────────

dbTest("upload, map, preview, commit -- an XLSX roster lands as rows", async () => {
  ensureDefinitions();
  const owner = await signIn();
  try {
    await withLocalStorage(async () => {
      const { id, proposal } = await startSession(owner, {
        definition: "people",
        filename: "people.xlsx",
        contentType: XLSX_TYPE,
        body: fixture("people.xlsx"),
      });

      // The proposal is already right for headings nobody tidied.
      assertEquals(proposal.map((p) => p.fieldKey), [
        "fullName",
        "email",
        "startDate",
        "team",
      ]);

      const preview = (await json(await get(owner, `/api/imports/sessions/${id}/preview`))).data;
      assertEquals(preview.counts, {
        total: 3,
        create: 3,
        update: 0,
        invalid: 0,
        duplicate: 0,
      });
      assertEquals(preview.problemRows, []);
      // The preview shows the value that will be WRITTEN, not the cell.
      assertEquals(preview.rows[0].values.firstName, "Ana");
      assertEquals(preview.rows[0].values.lastName, "Ruiz");
      assertEquals(preview.rows[0].values.email, "ana.ruiz@example.com");
      assertEquals(preview.rows[0].values.startDate, "2026-03-04");

      const result = (await json(await postJson(owner, `/api/imports/sessions/${id}/commit`)))
        .data.result;
      assertEquals(result.created, 3);
      assertEquals(result.updated, 0);
      assertEquals(result.skipped, 0);
      assertEquals(result.failed, 0);
      assertEquals(result.rolledBack, false);

      const rows = await roster(owner.organizationId);
      assertEquals(rows.length, 3);
      assertEquals(rows.map((r) => r.email), [
        "ana.ruiz@example.com",
        "bo@example.com",
        "chidi@example.com",
      ]);
      assertEquals(rows[0].firstName, "Ana");
      assertEquals(rows[0].lastName, "Ruiz");
      // The DATE column comes back as a Date at UTC midnight. Reading it
      // through toISOString gives the same day everywhere; String() or a
      // local getter would print the day before, west of Greenwich.
      assertEquals(new Date(rows[0].startDate!).toISOString().slice(0, 10), "2026-03-04");
      // The enum is stored in the DEFINITION's spelling: the file said
      // "support" in lower case.
      assertEquals(rows[2].team, "Support");
    });
  } finally {
    await owner.cleanup();
  }
});

dbTest("a re-import UPDATES; the roster does not grow", async () => {
  ensureDefinitions();
  const owner = await signIn();
  try {
    await withLocalStorage(async () => {
      const first = await startSession(owner, {
        definition: "people",
        filename: "people.xlsx",
        contentType: XLSX_TYPE,
        body: fixture("people.xlsx"),
      });
      await postJson(owner, `/api/imports/sessions/${first.id}/commit`);

      // Same file, second run. This is the case customers rebuild the
      // whole feature over: without identity matching, the roster
      // doubles.
      const second = await startSession(owner, {
        definition: "people",
        filename: "people.xlsx",
        contentType: XLSX_TYPE,
        body: fixture("people.xlsx"),
      });

      const preview = (await json(
        await get(owner, `/api/imports/sessions/${second.id}/preview`),
      )).data;
      assertEquals(preview.counts.update, 3);
      assertEquals(preview.counts.create, 0);
      assertEquals(preview.rows[0].action, "update");

      const result = (await json(
        await postJson(owner, `/api/imports/sessions/${second.id}/commit`),
      )).data.result;
      // The preview said three updates, and the commit did three
      // updates. That agreement is the point of preparing once.
      assertEquals(result.updated, 3);
      assertEquals(result.created, 0);

      assertEquals((await roster(owner.organizationId)).length, 3);
    });
  } finally {
    await owner.cleanup();
  }
});

dbTest("every row that does not land is named, with a reason", async () => {
  ensureDefinitions();
  const owner = await signIn();
  try {
    await withLocalStorage(async () => {
      const { id } = await startSession(owner, {
        definition: "people",
        filename: "people-problems.csv",
        contentType: "text/csv",
        body: fixture("people-problems.csv"),
      });

      const preview = (await json(await get(owner, `/api/imports/sessions/${id}/preview`))).data;
      assertEquals(preview.counts, {
        total: 4,
        create: 2,
        update: 0,
        invalid: 1,
        duplicate: 1,
      });

      // Row 2 is the same person as row 1, differing only in the case of
      // the address. Row 3's email does not parse.
      // deno-lint-ignore no-explicit-any
      const byRow = new Map(preview.problemRows.map((r: any) => [r.rowNumber, r]));
      assertEquals(byRow.size, 2);
      // deno-lint-ignore no-explicit-any
      assert((byRow.get(2) as any).reason.includes("Row 1 is the same record"));
      // deno-lint-ignore no-explicit-any
      assert((byRow.get(3) as any).reason.includes("not an email address"));

      const result = (await json(await postJson(owner, `/api/imports/sessions/${id}/commit`)))
        .data.result;
      assertEquals(result.created, 2);
      assertEquals(result.skipped, 2);
      assertEquals(result.failed, 0);
      // A count alone would let a person believe two rows evaporated.
      assertEquals(result.problemRows.map((r: { rowNumber: number }) => r.rowNumber), [2, 3]);

      assertEquals((await roster(owner.organizationId)).length, 2);
    });
  } finally {
    await owner.cleanup();
  }
});

dbTest("a write that fails rolls the whole import back and says so on every row", async () => {
  ensureDefinitions();
  const owner = await signIn();
  try {
    await withLocalStorage(async () => {
      const { id } = await startSession(owner, {
        definition: FAILING_IMPORT,
        filename: "people-simple.csv",
        contentType: "text/csv",
        // Three good rows, and the definition throws on the third.
        body: new TextEncoder().encode(
          "firstName,lastName,email\n" +
            "Ana,Ruiz,ana@example.com\n" +
            "Bo,Lindqvist,bo@example.com\n" +
            "Chidi,Okonjo,chidi@example.com\n",
        ),
      });

      const res = await postJson(owner, `/api/imports/sessions/${id}/commit`);
      assertEquals(res.status, 200);
      const body = await json(res);

      assertEquals(body.data.session.status, "failed");
      assertEquals(body.data.result.rolledBack, true);
      assertEquals(body.data.result.created, 0);
      assertEquals(body.data.result.failed, 1);
      // Rows 1 and 2 were written and then rolled back. Reporting them
      // as created would be a lie; leaving them out would be a silent
      // drop.
      assertEquals(body.data.result.problemRows.length, 3);
      // deno-lint-ignore no-explicit-any
      const third = body.data.result.problemRows.find((r: any) => r.rowNumber === 3);
      assertEquals(third.outcome, "failed");
      assert(third.reason.includes("the third row always fails"), third.reason);
      // deno-lint-ignore no-explicit-any
      const first = body.data.result.problemRows.find((r: any) => r.rowNumber === 1);
      assertEquals(first.outcome, "skipped");
      assert(first.reason.includes("rolled back"), first.reason);

      // Nothing at all landed.
      assertEquals((await roster(owner.organizationId)).length, 0);
    });
  } finally {
    await owner.cleanup();
  }
});

// ── Mapping ────────────────────────────────────────────────────────────────

dbTest("a mapping that drops a required column is refused before the preview", async () => {
  ensureDefinitions();
  const owner = await signIn();
  try {
    await withLocalStorage(async () => {
      const { id } = await startSession(owner, {
        definition: "people",
        filename: "people-simple.csv",
        contentType: "text/csv",
        body: fixture("people-simple.csv"),
      });

      const res = await patchJson(owner, `/api/imports/sessions/${id}/mapping`, {
        mapping: [
          { columnIndex: 0, fieldKey: "firstName" },
          { columnIndex: 1, fieldKey: "lastName" },
          { columnIndex: 2, fieldKey: null },
        ],
      });
      assertEquals(res.status, 400);
      const body = await json(res);
      assert(body.error.includes("Email is required"), body.error);
    });
  } finally {
    await owner.cleanup();
  }
});

dbTest("a column can be kept as custom data and reaches the handler as an extra", async () => {
  ensureDefinitions();
  const owner = await signIn();
  const seen: Array<Record<string, string>> = [];

  const withExtras: ImportDefinition = {
    ...failingDefinition,
    name: "test-extras",
    upsertRow: async ({ trx, organizationId, values, extras }) => {
      seen.push(extras);
      const row = await trx
        .insertInto("import_demo_people")
        .values({
          organizationId,
          firstName: String(values.firstName),
          email: String(values.email),
        })
        .returning(["id"])
        .executeTakeFirstOrThrow();
      return { id: row.id };
    },
  };
  if (!findImportDefinition("test-extras")) registerImportDefinition(withExtras);

  try {
    await withLocalStorage(async () => {
      const { id } = await startSession(owner, {
        definition: "test-extras",
        filename: "extras.csv",
        contentType: "text/csv",
        body: new TextEncoder().encode(
          "firstName,email,Cost centre\nAna,ana@example.com,CC-9\n",
        ),
      });

      await patchJson(owner, `/api/imports/sessions/${id}/mapping`, {
        mapping: [
          { columnIndex: 0, fieldKey: "firstName" },
          { columnIndex: 1, fieldKey: "email" },
          { columnIndex: 2, fieldKey: null, custom: "Cost centre" },
        ],
      });

      const result = (await json(await postJson(owner, `/api/imports/sessions/${id}/commit`)))
        .data.result;
      assertEquals(result.created, 1);
      assertEquals(seen, [{ "Cost centre": "CC-9" }]);
    });
  } finally {
    await owner.cleanup();
  }
});

// ── The wizard's own path: UploadField first, then the session ─────────────

/** Post a file the way <UploadField> does, and return its id. */
async function uploadThroughPavedRoad(
  person: Person,
  opts: { filename: string; contentType: string; body: Uint8Array },
): Promise<string> {
  const form = new FormData();
  form.set("file", new File([opts.body], opts.filename, { type: opts.contentType }));
  form.set("subjectType", "import");
  form.set("subjectId", "people");
  const res = await app.request("/api/files/uploads", {
    method: "POST",
    headers: { cookie: person.cookie },
    body: form,
  });
  assertEquals(res.status, 201, await res.clone().text());
  return (await json(res)).data.id;
}

dbTest("a session opens on a file the uploads paved road already stored", async () => {
  ensureDefinitions();
  const owner = await signIn();
  try {
    await withLocalStorage(async () => {
      const uploadedFileId = await uploadThroughPavedRoad(owner, {
        filename: "people-simple.csv",
        contentType: "text/csv",
        body: fixture("people-simple.csv"),
      });

      const res = await postJson(owner, "/api/imports/sessions", {
        definition: "people",
        uploadedFileId,
      });
      assertEquals(res.status, 201, await res.clone().text());
      const body = await json(res);
      assertEquals(body.data.session.rowCount, 2);
      assertEquals(body.data.proposal.map((p: { fieldKey: string | null }) => p.fieldKey), [
        "firstName",
        "lastName",
        "email",
      ]);

      const result = (await json(
        await postJson(owner, `/api/imports/sessions/${body.data.session.id}/commit`),
      )).data.result;
      assertEquals(result.created, 2);
    });
  } finally {
    await owner.cleanup();
  }
});

dbTest("a stored file of the wrong type is refused by the definition's narrowing", async () => {
  ensureDefinitions();
  const owner = await signIn();
  try {
    await withLocalStorage(async () => {
      // A PDF is a perfectly legitimate upload for this app, and it is
      // still not a spreadsheet. The app-wide allowlist is wider than
      // one import's, so the import re-checks.
      const uploadedFileId = await uploadThroughPavedRoad(owner, {
        filename: "scan.pdf",
        contentType: "application/pdf",
        body: new TextEncoder().encode("%PDF-1.7 sample"),
      });

      const res = await postJson(owner, "/api/imports/sessions", {
        definition: "people",
        uploadedFileId,
      });
      assertEquals(res.status, 400);
      const body = await json(res);
      assert(body.error.includes(".csv"), body.error);
    });
  } finally {
    await owner.cleanup();
  }
});

dbTest("another workspace's uploaded file cannot be imported", async () => {
  ensureDefinitions();
  const mine = await signIn();
  const theirs = await signIn();
  try {
    await withLocalStorage(async () => {
      const uploadedFileId = await uploadThroughPavedRoad(mine, {
        filename: "people-simple.csv",
        contentType: "text/csv",
        body: fixture("people-simple.csv"),
      });

      const res = await postJson(theirs, "/api/imports/sessions", {
        definition: "people",
        uploadedFileId,
      });
      assertEquals(res.status, 404);
    });
  } finally {
    await mine.cleanup();
    await theirs.cleanup();
  }
});

// ── Authorization ──────────────────────────────────────────────────────────

dbTest("the definition's capability gates the upload", async () => {
  ensureDefinitions();
  const viewer = await signIn("viewer");
  try {
    await withLocalStorage(async () => {
      const res = await uploadFile(viewer, {
        definition: "people",
        filename: "people-simple.csv",
        contentType: "text/csv",
        body: fixture("people-simple.csv"),
      });
      assertEquals(res.status, 403);
    });
  } finally {
    await viewer.cleanup();
  }
});

dbTest("one workspace cannot see, preview or commit another's import", async () => {
  ensureDefinitions();
  const mine = await signIn();
  const theirs = await signIn();
  try {
    await withLocalStorage(async () => {
      const { id } = await startSession(mine, {
        definition: "people",
        filename: "people-simple.csv",
        contentType: "text/csv",
        body: fixture("people-simple.csv"),
      });

      // Another workspace's session id is indistinguishable from a
      // made-up one (CWE-639).
      assertEquals((await get(theirs, `/api/imports/sessions/${id}`)).status, 404);
      assertEquals((await get(theirs, `/api/imports/sessions/${id}/preview`)).status, 404);
      assertEquals(
        (await postJson(theirs, `/api/imports/sessions/${id}/commit`)).status,
        404,
      );
      assertEquals(
        (await patchJson(theirs, `/api/imports/sessions/${id}/mapping`, {
          mapping: [{ columnIndex: 0, fieldKey: "firstName" }],
        })).status,
        404,
      );

      // ...and their own list does not contain it.
      const list = (await json(await get(theirs, "/api/imports/sessions"))).data;
      assertEquals(list.length, 0);
    });
  } finally {
    await mine.cleanup();
    await theirs.cleanup();
  }
});

dbTest("an unknown definition is a 404, not a 500", async () => {
  ensureDefinitions();
  const owner = await signIn();
  try {
    assertEquals((await get(owner, "/api/imports/definitions/nope")).status, 404);
    await withLocalStorage(async () => {
      const res = await uploadFile(owner, {
        definition: "nope",
        filename: "x.csv",
        contentType: "text/csv",
        body: fixture("people-simple.csv"),
      });
      assertEquals(res.status, 404);
    });
  } finally {
    await owner.cleanup();
  }
});

dbTest("committing the same session twice is a conflict, not a second write", async () => {
  ensureDefinitions();
  const owner = await signIn();
  try {
    await withLocalStorage(async () => {
      const { id } = await startSession(owner, {
        definition: "people",
        filename: "people-simple.csv",
        contentType: "text/csv",
        body: fixture("people-simple.csv"),
      });

      assertEquals((await postJson(owner, `/api/imports/sessions/${id}/commit`)).status, 200);
      assertEquals((await postJson(owner, `/api/imports/sessions/${id}/commit`)).status, 409);
      assertEquals((await roster(owner.organizationId)).length, 2);
    });
  } finally {
    await owner.cleanup();
  }
});

dbTest("a file the parser cannot read never opens a session", async () => {
  ensureDefinitions();
  const owner = await signIn();
  try {
    await withLocalStorage(async () => {
      const res = await uploadFile(owner, {
        definition: "people",
        filename: "empty.csv",
        contentType: "text/csv",
        body: new Uint8Array(),
      });
      assertEquals(res.status, 400);

      // No dead session, and no orphan object behind it.
      const list = (await json(await get(owner, "/api/imports/sessions"))).data;
      assertEquals(list.length, 0);
    });
  } finally {
    await owner.cleanup();
  }
});
