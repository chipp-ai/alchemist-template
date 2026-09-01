/**
 * Cell normalization, derivations, and the registry's coherence checks.
 *
 * The cases here are the ones that decide whether an import is trusted:
 * a date read the wrong way round, an email that is really two emails, a
 * name split that quietly overwrites a column somebody supplied on
 * purpose. Each one is silent damage if it goes wrong, which is why each
 * one is a test rather than a comment.
 */

import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  clearImportDefinitions,
  type ImportDefinition,
  type ImportFieldSpec,
  registerImportDefinition,
  splitFullName,
} from "@/services/import/definitions.ts";
import { normalizeCell, normalizeRow } from "@/services/import/normalize.ts";

function field(spec: Partial<ImportFieldSpec> & { key: string }): ImportFieldSpec {
  return { label: spec.key, kind: "text", ...spec };
}

/** A definition with no data access. Enough for row-level normalization. */
function definition(over: Partial<ImportDefinition> = {}): ImportDefinition {
  return {
    name: "test",
    label: "Test",
    description: "Test",
    fields: [field({ key: "email", kind: "email", required: true })],
    matchBy: [["email"]],
    loadExisting: () => Promise.resolve([]),
    upsertRow: () => Promise.resolve({ id: "x" }),
    ...over,
  };
}

// ── Text ───────────────────────────────────────────────────────────────────

Deno.test("text: whitespace is collapsed, not just trimmed", () => {
  const result = normalizeCell(field({ key: "name" }), "  Ana   Maria  Ruiz ");
  assertEquals(result.value, "Ana Maria Ruiz");
  assertEquals(result.error, null);
});

Deno.test("text: an over-long value is REFUSED, never truncated", () => {
  const result = normalizeCell(field({ key: "name", maxLength: 5 }), "Alexandra");
  assertEquals(result.value, null);
  assert(result.error?.includes("longer than 5"), String(result.error));
});

Deno.test("an empty cell is null, not an error", () => {
  assertEquals(normalizeCell(field({ key: "name" }), "   "), { value: null, error: null });
});

// ── Email ──────────────────────────────────────────────────────────────────

Deno.test("email: lowercased, so identity matching is case-insensitive by construction", () => {
  const result = normalizeCell(field({ key: "email", kind: "email" }), " ANA.Ruiz@Example.COM ");
  assertEquals(result.value, "ana.ruiz@example.com");
});

Deno.test("email: rubbish is named, not stored", () => {
  for (const bad of ["n/a", "ana at example.com", "ana@example", "@example.com", "ana@.com"]) {
    const result = normalizeCell(field({ key: "email", kind: "email" }), bad);
    assertEquals(result.value, null, `${bad} should not parse`);
    assert(result.error, `${bad} should have an error`);
  }
});

Deno.test("email: two addresses in one cell is its own message", () => {
  const result = normalizeCell(
    field({ key: "email", kind: "email" }),
    "ana@example.com, bo@example.com",
  );
  assert(result.error?.includes("more than one"), String(result.error));
});

// ── Dates ──────────────────────────────────────────────────────────────────

Deno.test("date: ISO, slashes, and named months in either order", () => {
  const spec = field({ key: "startDate", kind: "date" });
  assertEquals(normalizeCell(spec, "2026-03-04").value, "2026-03-04");
  assertEquals(normalizeCell(spec, "2026/3/4").value, "2026-03-04");
  assertEquals(normalizeCell(spec, "4 Mar 2026").value, "2026-03-04");
  assertEquals(normalizeCell(spec, "4-March-2026").value, "2026-03-04");
  assertEquals(normalizeCell(spec, "Mar 4, 2026").value, "2026-03-04");
  assertEquals(normalizeCell(spec, "September 9, 2026").value, "2026-09-09");
});

Deno.test("date: an ambiguous numeric date follows the DEFINITION's declared order", () => {
  assertEquals(
    normalizeCell(field({ key: "d", kind: "date", dateOrder: "mdy" }), "3/4/2026").value,
    "2026-03-04",
  );
  assertEquals(
    normalizeCell(field({ key: "d", kind: "date", dateOrder: "dmy" }), "3/4/2026").value,
    "2026-04-03",
  );
});

Deno.test("date: a time component is dropped, the date is kept", () => {
  const spec = field({ key: "d", kind: "date" });
  assertEquals(normalizeCell(spec, "2026-03-04T09:30:00.000Z").value, "2026-03-04");
  assertEquals(normalizeCell(spec, "2026-03-04 09:30:00").value, "2026-03-04");
});

Deno.test("date: an impossible day is an error, NOT a rollover into next month", () => {
  const spec = field({ key: "d", kind: "date" });
  // JavaScript would read this as March 2nd. Quietly moving somebody's
  // start date is worse than stopping.
  assertEquals(normalizeCell(spec, "2026-02-30").value, null);
  assertEquals(normalizeCell(spec, "13/1/2026").value, null);
  assertEquals(normalizeCell(spec, "not a date").value, null);
});

Deno.test("date: a leap day is real in a leap year and not in an ordinary one", () => {
  const spec = field({ key: "d", kind: "date" });
  assertEquals(normalizeCell(spec, "2028-02-29").value, "2028-02-29");
  assertEquals(normalizeCell(spec, "2026-02-29").value, null);
});

Deno.test("date: two-digit years follow the POSIX rule", () => {
  const spec = field({ key: "d", kind: "date", dateOrder: "mdy" });
  assertEquals(normalizeCell(spec, "3/4/26").value, "2026-03-04");
  assertEquals(normalizeCell(spec, "3/4/85").value, "1985-03-04");
});

// ── Numbers, booleans, enums ───────────────────────────────────────────────

Deno.test("number: thousands separators and a currency symbol are formatting", () => {
  const spec = field({ key: "n", kind: "number" });
  assertEquals(normalizeCell(spec, "1,250").value, 1250);
  assertEquals(normalizeCell(spec, "$1,250.50").value, 1250.5);
  assertEquals(normalizeCell(spec, "-3").value, -3);
  assertEquals(normalizeCell(spec, "twelve").value, null);
});

Deno.test("boolean: a fixed vocabulary, and anything outside it is an error", () => {
  const spec = field({ key: "b", kind: "boolean" });
  assertEquals(normalizeCell(spec, "Yes").value, true);
  assertEquals(normalizeCell(spec, "N").value, false);
  assertEquals(normalizeCell(spec, "1").value, true);
  // "pending" is not a no. Guessing here would flip somebody's flag.
  assertEquals(normalizeCell(spec, "pending").value, null);
});

Deno.test("enum: matched loosely, stored in the DEFINITION's spelling", () => {
  const spec = field({ key: "team", kind: "enum", options: ["Engineering", "Sales"] });
  assertEquals(normalizeCell(spec, "engineering").value, "Engineering");
  assertEquals(normalizeCell(spec, " ENGINEERING ").value, "Engineering");
  const miss = normalizeCell(spec, "Marketing");
  assertEquals(miss.value, null);
  assert(miss.error?.includes("Engineering, Sales"), String(miss.error));
});

// ── Derivations ────────────────────────────────────────────────────────────

const rosterDefinition = definition({
  fields: [
    field({ key: "fullName", label: "Full name", inputOnly: true }),
    field({ key: "firstName", label: "First name", required: true }),
    field({ key: "lastName", label: "Last name" }),
    field({ key: "email", label: "Email", kind: "email", required: true }),
  ],
  derive: [splitFullName({ from: "fullName", first: "firstName", last: "lastName" })],
  matchBy: [["email"]],
});

Deno.test("splitFullName: the last space is the split", () => {
  const row = normalizeRow(rosterDefinition, {
    cells: { fullName: "Ana Maria Ruiz Diaz", email: "ana@example.com" },
  });
  assertEquals(row.errors, []);
  assertEquals(row.values.firstName, "Ana Maria Ruiz");
  assertEquals(row.values.lastName, "Diaz");
});

Deno.test("splitFullName: a comma flips it, because that form IS unambiguous", () => {
  const row = normalizeRow(rosterDefinition, {
    cells: { fullName: "Ruiz, Ana", email: "ana@example.com" },
  });
  assertEquals(row.values.firstName, "Ana");
  assertEquals(row.values.lastName, "Ruiz");
});

Deno.test("splitFullName: one word is a first name, and last stays empty", () => {
  const row = normalizeRow(rosterDefinition, {
    cells: { fullName: "Prince", email: "p@example.com" },
  });
  assertEquals(row.values.firstName, "Prince");
  assertEquals(row.values.lastName, null);
});

Deno.test("an explicit column always beats a derived value", () => {
  const row = normalizeRow(rosterDefinition, {
    cells: { fullName: "Ruiz, Ana", firstName: "Anastasia", email: "ana@example.com" },
  });
  assertEquals(row.values.firstName, "Anastasia");
  // The derivation still fills what the file left empty.
  assertEquals(row.values.lastName, "Ruiz");
});

Deno.test("an inputOnly field never reaches the upsert handler", () => {
  const row = normalizeRow(rosterDefinition, {
    cells: { fullName: "Ana Ruiz", email: "ana@example.com" },
  });
  assertEquals("fullName" in row.values, false);
  // ...but it is still available for display and identity matching.
  assertEquals(row.allValues.fullName, "Ana Ruiz");
});

Deno.test("required is checked AFTER derivation", () => {
  // firstName is required and no column fills it. The split does.
  const derived = normalizeRow(rosterDefinition, {
    cells: { fullName: "Ana Ruiz", email: "ana@example.com" },
  });
  assertEquals(derived.errors, []);

  const missing = normalizeRow(rosterDefinition, { cells: { email: "ana@example.com" } });
  assertEquals(missing.errors.length, 1);
  assertEquals(missing.errors[0].field, "firstName");
  assert(missing.errors[0].message.includes("required"));
});

Deno.test("a cell that failed to parse reports ONE problem, not two", () => {
  const row = normalizeRow(rosterDefinition, {
    cells: { firstName: "Ana", email: "not-an-email" },
  });
  // Not "is not an email address" AND "is required" for the same cell.
  assertEquals(row.errors.length, 1);
  assertEquals(row.errors[0].field, "email");
});

Deno.test("custom columns ride along as extras, untouched", () => {
  const row = normalizeRow(rosterDefinition, {
    cells: { firstName: "Ana", email: "ana@example.com" },
    extras: { "Payroll ID": " 4471 " },
  });
  assertEquals(row.extras, { "Payroll ID": " 4471 " });
});

// ── Registry coherence ─────────────────────────────────────────────────────

Deno.test("registration refuses a definition that contradicts itself", async (t) => {
  const cases: Array<[string, Partial<ImportDefinition>, string]> = [
    [
      "matchBy naming a field that does not exist",
      { name: "a", matchBy: [["nope"]] },
      "not a field",
    ],
    [
      "a derivation producing a field that does not exist",
      {
        name: "b",
        derive: [{ from: ["email"], produces: ["nope"], run: () => ({}) }],
      },
      "not a field",
    ],
    [
      "an enum with no options",
      { name: "c", fields: [field({ key: "team", kind: "enum" })], matchBy: [["team"]] },
      "enum with no options",
    ],
    [
      "a required input-only field nothing derives",
      {
        name: "d",
        fields: [field({ key: "email", kind: "email", required: true, inputOnly: true })],
        matchBy: [["email"]],
      },
      "input-only",
    ],
    ["duplicate field keys", {
      name: "e",
      fields: [field({ key: "email" }), field({ key: "email" })],
      matchBy: [["email"]],
    }, "duplicate field keys"],
  ];

  for (const [label, over, expected] of cases) {
    await t.step(label, () => {
      clearImportDefinitions();
      const err = assertThrows(() => registerImportDefinition(definition(over)), Error);
      assert(err.message.includes(expected), `${err.message} should mention ${expected}`);
    });
  }

  clearImportDefinitions();
});

Deno.test("registration refuses a duplicate name", () => {
  clearImportDefinitions();
  try {
    registerImportDefinition(definition({ name: "people" }));
    const err = assertThrows(
      () => registerImportDefinition(definition({ name: "people" })),
      Error,
    );
    assert(err.message.includes("already registered"), err.message);
  } finally {
    clearImportDefinitions();
  }
});
