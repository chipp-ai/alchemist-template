/**
 * Column mapping and identity matching.
 *
 * Two different jobs, and both are the reason a customer stops paying an
 * agent to rebuild this feature:
 *
 *   the mapping screen should already be correct, so a person confirms
 *   rather than fills in thirty dropdowns;
 *
 *   a second import of the same file should update the people who are
 *   already there, not add them again.
 */

import { assert, assertEquals } from "@std/assert";
import type { ImportDefinition, ImportFieldSpec } from "@/services/import/definitions.ts";
import {
  buildIdentityIndex,
  identityKeys,
  proposeMapping,
  resolveMapping,
  rowCells,
} from "@/services/import/mapping.ts";

function field(spec: Partial<ImportFieldSpec> & { key: string }): ImportFieldSpec {
  return { label: spec.key, kind: "text", ...spec };
}

const roster: ImportDefinition = {
  name: "roster",
  label: "Roster",
  description: "Test",
  fields: [
    field({ key: "fullName", label: "Full name", inputOnly: true, aliases: ["employee"] }),
    field({ key: "firstName", label: "First name", required: true, aliases: ["given name"] }),
    field({ key: "lastName", label: "Last name", aliases: ["surname"] }),
    field({ key: "email", label: "Email", kind: "email", required: true, aliases: ["contact"] }),
    field({ key: "startDate", label: "Start date", kind: "date", aliases: ["hire date"] }),
  ],
  derive: [
    { from: ["fullName"], produces: ["firstName", "lastName"], run: () => ({}) },
  ],
  matchBy: [["email"], ["firstName", "lastName"]],
  loadExisting: () => Promise.resolve([]),
  upsertRow: () => Promise.resolve({ id: "x" }),
};

function mapped(columns: string[]): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const p of proposeMapping(columns, roster)) out[p.columnLabel] = p.fieldKey;
  return out;
}

// ── Header matching ────────────────────────────────────────────────────────

Deno.test("mapping: an exact heading matches the key or the label", () => {
  assertEquals(mapped(["email", "Last name"]), { email: "email", "Last name": "lastName" });
});

Deno.test("mapping: case, spaces and punctuation do not matter", () => {
  assertEquals(
    mapped(["  E-MAIL  ", "first_name", "Start   Date", "LastName"]),
    {
      "  E-MAIL  ": "email",
      first_name: "firstName",
      "Start   Date": "startDate",
      LastName: "lastName",
    },
  );
});

Deno.test("mapping: a declared alias matches a heading that shares no words", () => {
  assertEquals(mapped(["Surname", "Hire Date", "Employee"]), {
    Surname: "lastName",
    "Hire Date": "startDate",
    Employee: "fullName",
  });
});

Deno.test("mapping: an unrecognised heading is proposed as skip, with no guess", () => {
  const [proposal] = proposeMapping(["Cost centre"], roster);
  assertEquals(proposal.fieldKey, null);
  assertEquals(proposal.confidence, "none");
  assertEquals(proposal.ambiguous, false);
});

Deno.test("mapping: two columns wanting the same field IN THE SAME PASS are both left", () => {
  // Both squash to "email", so neither is a better answer than the
  // other. Picking one on column order would silently discard the other.
  const proposals = proposeMapping(["E-Mail", "e mail"], roster);
  assertEquals(proposals.map((p) => p.fieldKey), [null, null]);
  assert(proposals.every((p) => p.ambiguous));
  assertEquals(proposals[0].candidates, ["email"]);
});

Deno.test("mapping: a heading two fields could claim is left for a person", () => {
  const ambiguous: ImportDefinition = {
    ...roster,
    fields: [
      field({ key: "billingName", label: "Billing name", aliases: ["name"] }),
      field({ key: "shippingName", label: "Shipping name", aliases: ["name"] }),
      field({ key: "email", label: "Email", kind: "email" }),
    ],
    derive: [],
    matchBy: [["email"]],
  };

  const [proposal] = proposeMapping(["Name"], ambiguous);
  assertEquals(proposal.fieldKey, null);
  assertEquals(proposal.ambiguous, true);
  assertEquals(proposal.candidates.sort(), ["billingName", "shippingName"]);
});

Deno.test("mapping: an exact match wins over another column's fuzzy claim", () => {
  // "Contact" is an alias of email; "Email" is exact. The exact pass
  // runs first and takes the field, so the alias pass has nothing left
  // to claim and "Contact" is proposed as skip rather than fighting.
  const proposals = proposeMapping(["Contact", "Email"], roster);
  assertEquals(proposals[1].fieldKey, "email");
  assertEquals(proposals[1].confidence, "exact");
  assertEquals(proposals[0].fieldKey, null);
});

Deno.test("mapping: the confidence tier is reported, so a UI can flag a weak guess", () => {
  const proposals = proposeMapping(["email", "Surname", "start   date"], roster);
  assertEquals(proposals.map((p) => p.confidence), ["exact", "alias", "fuzzy"]);
});

// ── Resolving a submitted mapping ──────────────────────────────────────────

const columns = ["Full Name", "Work E-Mail", "Start Date", "Cost centre"];

Deno.test("resolve: a workable mapping resolves clean", () => {
  const { byColumn, errors } = resolveMapping(
    [
      { columnIndex: 0, fieldKey: "fullName" },
      { columnIndex: 1, fieldKey: "email" },
      { columnIndex: 2, fieldKey: "startDate" },
      { columnIndex: 3, fieldKey: null, custom: "Cost centre" },
    ],
    columns,
    roster,
  );
  assertEquals(errors, []);
  assertEquals(byColumn.get(3), { fieldKey: null, custom: "Cost centre" });
});

Deno.test("resolve: one field mapped from two columns is refused, not silently halved", () => {
  const { errors } = resolveMapping(
    [
      { columnIndex: 0, fieldKey: "email" },
      { columnIndex: 1, fieldKey: "email" },
      { columnIndex: 2, fieldKey: "firstName" },
    ],
    columns,
    roster,
  );
  assert(errors.some((e) => e.includes("Pick one")), errors.join(" "));
});

Deno.test("resolve: an unknown field key is refused", () => {
  const { errors } = resolveMapping(
    [{ columnIndex: 0, fieldKey: "salary" }, { columnIndex: 1, fieldKey: "email" }],
    columns,
    roster,
  );
  assert(errors.some((e) => e.includes("not a field")), errors.join(" "));
});

Deno.test("resolve: a column index outside the file is refused", () => {
  const { errors } = resolveMapping(
    [{ columnIndex: 99, fieldKey: "email" }],
    columns,
    roster,
  );
  assert(errors.some((e) => e.includes("no column 100")), errors.join(" "));
});

Deno.test("resolve: a required field with no column is refused BEFORE anything runs", () => {
  const { errors } = resolveMapping(
    [{ columnIndex: 2, fieldKey: "startDate" }],
    columns,
    roster,
  );
  assert(errors.some((e) => e.includes("Email is required")), errors.join(" "));
});

Deno.test("resolve: a derivation satisfies a required field", () => {
  // firstName is required and unmapped; the fullName derivation produces it.
  const { errors } = resolveMapping(
    [{ columnIndex: 0, fieldKey: "fullName" }, { columnIndex: 1, fieldKey: "email" }],
    columns,
    roster,
  );
  assertEquals(errors, []);
});

Deno.test("resolve: two columns kept under one custom name are refused", () => {
  const { errors } = resolveMapping(
    [
      { columnIndex: 0, fieldKey: "fullName" },
      { columnIndex: 1, fieldKey: "email" },
      { columnIndex: 2, fieldKey: null, custom: "Extra" },
      { columnIndex: 3, fieldKey: null, custom: "extra" },
    ],
    columns,
    roster,
  );
  assert(errors.some((e) => e.includes("different names")), errors.join(" "));
});

Deno.test("rowCells: fields and extras are split, unmapped columns are dropped", () => {
  const { byColumn } = resolveMapping(
    [
      { columnIndex: 0, fieldKey: "fullName" },
      { columnIndex: 1, fieldKey: "email" },
      { columnIndex: 2, fieldKey: null },
      { columnIndex: 3, fieldKey: null, custom: "Cost centre" },
    ],
    columns,
    roster,
  );

  const { cells, extras } = rowCells(
    ["Ana Ruiz", "ana@example.com", "2026-01-01", "CC-9"],
    byColumn,
  );
  assertEquals(cells, { fullName: "Ana Ruiz", email: "ana@example.com" });
  assertEquals(extras, { "Cost centre": "CC-9" });
});

// ── Identity matching ──────────────────────────────────────────────────────

Deno.test("identity: a tuple with a missing part produces NO key", () => {
  // Half a name pair identifies nobody. Treating it as a match would
  // merge two people.
  const keys = identityKeys({ email: null, firstName: "Ana", lastName: null }, roster.matchBy);
  assertEquals(keys, []);
});

Deno.test("identity: matching folds case and collapses whitespace", () => {
  const index = buildIdentityIndex(
    [{ id: "person-1", values: { email: "ana@example.com", firstName: "Ana", lastName: "Ruiz" } }],
    roster.matchBy,
  );

  assertEquals(index.lookup({ email: "ANA@Example.com " }), "person-1");
  assertEquals(index.lookup({ firstName: " ana ", lastName: "RUIZ" }), "person-1");
  // A different person with the same surname is not a match.
  assertEquals(index.lookup({ firstName: "Bo", lastName: "Ruiz" }), null);
});

Deno.test("identity: the tuples are tried in order, best key first", () => {
  const index = buildIdentityIndex(
    [
      { id: "by-email", values: { email: "ana@example.com", firstName: "Zoe", lastName: "Zed" } },
      { id: "by-name", values: { email: "other@example.com", firstName: "Ana", lastName: "Ruiz" } },
    ],
    roster.matchBy,
  );

  // Email is the first tuple, so it decides even though the name pair
  // also matches a different record.
  assertEquals(
    index.lookup({ email: "ana@example.com", firstName: "Ana", lastName: "Ruiz" }),
    "by-email",
  );
});

Deno.test("identity: no match at all is a create", () => {
  const index = buildIdentityIndex([], roster.matchBy);
  assertEquals(index.lookup({ email: "new@example.com" }), null);
});
