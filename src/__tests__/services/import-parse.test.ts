/**
 * Spreadsheet parsing -- CSV and XLSX, against committed fixtures.
 *
 * The fixtures are the point. `people-messy.csv` carries a UTF-8 BOM,
 * two junk rows and a blank one above the real headings, padded header
 * cells, a quoted field with a comma in it, doubled quotes, a blank row
 * in the middle, and three different date spellings, because that is
 * what a spreadsheet a person actually exported looks like. `people.xlsx`
 * carries genuine DATE cells, which is the one thing a CSV cannot test.
 */

import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  detectHeaderRow,
  MAX_IMPORT_COLUMNS,
  parseCsv,
  parseSpreadsheet,
} from "@/services/import/parse.ts";
import { BadRequestError } from "@/utils/errors.ts";

const FIXTURES = new URL("../fixtures/import/", import.meta.url);

function fixture(name: string): Uint8Array {
  return Deno.readFileSync(new URL(name, FIXTURES));
}

function text(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

// ── CSV ────────────────────────────────────────────────────────────────────

Deno.test("parseCsv: quoted commas, doubled quotes, embedded newlines, CRLF", () => {
  const rows = parseCsv('name,note\r\nAna,"line one\r\nline two"\r\nBo,"a, comma"\r\n');
  assertEquals(rows, [
    ["name", "note"],
    ["Ana", "line one\r\nline two"],
    ["Bo", "a, comma"],
  ]);
});

Deno.test("parseCsv: a trailing newline does not invent an empty final row", () => {
  assertEquals(parseCsv("a,b\n1,2\n"), [["a", "b"], ["1", "2"]]);
  // ...and a final line WITHOUT one is not dropped.
  assertEquals(parseCsv("a,b\n1,2"), [["a", "b"], ["1", "2"]]);
});

Deno.test("parseCsv: an empty trailing field is a field, not nothing", () => {
  assertEquals(parseCsv("a,b,c\n1,,"), [["a", "b", "c"], ["1", "", ""]]);
});

Deno.test("parse: a clean CSV", () => {
  const parsed = parseSpreadsheet(fixture("people-simple.csv"), {
    filename: "people-simple.csv",
    contentType: "text/csv",
  });

  assertEquals(parsed.format, "csv");
  assertEquals(parsed.columns, ["firstName", "lastName", "email"]);
  assertEquals(parsed.headerRowIndex, 0);
  assertEquals(parsed.rows.length, 2);
  assertEquals(parsed.rows[0], ["Ana", "Ruiz", "ana.ruiz@example.com"]);
});

Deno.test("parse: a messy CSV -- BOM, junk rows, padding, quotes, blank row", () => {
  const parsed = parseSpreadsheet(fixture("people-messy.csv"), {
    filename: "roster.csv",
    contentType: "text/csv",
  });

  // The two title rows and the blank one are found and reported, not
  // silently swallowed and not mistaken for the header.
  assertEquals(parsed.headerRowIndex, 3);
  assertEquals(parsed.skippedLeadingRows, 3);

  // The BOM is gone from the first heading, and headings are trimmed.
  assertEquals(parsed.columns, ["Full Name", "Work E-Mail", "Start Date", "Department"]);

  // The blank row between two data rows is dropped; the three people are not.
  assertEquals(parsed.rows.length, 3);
  assertEquals(parsed.rows[0][0], "Ruiz, Ana");
  assertEquals(parsed.rows[1][0], 'Bo "Bosse" Lindqvist');
  assertEquals(parsed.rows[2][2], "15 May 2026");
});

Deno.test("parse: a CSV that is not UTF-8 is refused with a readable message", () => {
  // 0xFF is not valid UTF-8 anywhere.
  const latin1 = new Uint8Array([...text("name\nAna"), 0xff, ...text("Ruiz")]);
  const err = assertThrows(
    () => parseSpreadsheet(latin1, { filename: "x.csv", contentType: "text/csv" }),
    BadRequestError,
  );
  assert(err.message.includes("UTF-8"), err.message);
});

Deno.test("parse: an empty file is a 400, not a crash", () => {
  assertThrows(
    () => parseSpreadsheet(new Uint8Array(), { filename: "x.csv" }),
    BadRequestError,
  );
});

Deno.test("parse: too many columns is refused", () => {
  const wide = Array.from({ length: MAX_IMPORT_COLUMNS + 1 }, (_, i) => `c${i}`).join(",");
  assertThrows(
    () => parseSpreadsheet(text(`${wide}\n`), { filename: "wide.csv" }),
    BadRequestError,
  );
});

// ── Header detection ───────────────────────────────────────────────────────

Deno.test("detectHeaderRow: a single-cell title row never wins", () => {
  const grid = [
    ["Quarterly export"],
    ["Name", "Email"],
    ["Ana", "ana@example.com"],
  ];
  assertEquals(detectHeaderRow(grid), 1);
});

Deno.test("detectHeaderRow: a numeric row never wins", () => {
  const grid = [
    ["1", "2", "3"],
    ["Name", "Email", "Team"],
    ["Ana", "ana@example.com", "Sales"],
  ];
  assertEquals(detectHeaderRow(grid), 1);
});

Deno.test("detectHeaderRow: a tie goes to the earlier row, which is the header", () => {
  const grid = [
    ["Name", "Email"],
    ["Ana", "ana@example.com"],
  ];
  assertEquals(detectHeaderRow(grid), 0);
});

Deno.test("parse: an explicit header row index overrides detection", () => {
  const parsed = parseSpreadsheet(fixture("people-messy.csv"), {
    filename: "roster.csv",
    headerRowIndex: 0,
  });
  // Row 0 is the title row, so its one filled cell is the only column.
  assertEquals(parsed.columns, ["Staff roster"]);
});

// ── Column labels ──────────────────────────────────────────────────────────

Deno.test("parse: a blank heading becomes Column N and a repeat gets a suffix", () => {
  // Header row given explicitly: a heading row with a hole in it is
  // NARROWER than the data under it, so detection would rightly prefer
  // the data row. Labelling is what this case is about.
  const parsed = parseSpreadsheet(text("Email,,Email\na,b,c\n"), {
    filename: "x.csv",
    headerRowIndex: 0,
  });
  assertEquals(parsed.columns, ["Email", "Column 2", "Email (2)"]);
  assertEquals(parsed.rows, [["a", "b", "c"]]);
});

// ── XLSX ───────────────────────────────────────────────────────────────────

Deno.test("parse: an XLSX with real date cells", () => {
  const parsed = parseSpreadsheet(fixture("people.xlsx"), {
    filename: "people.xlsx",
    contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });

  assertEquals(parsed.format, "xlsx");
  assertEquals(parsed.sheetName, "Roster");
  // 1, not 2: sheetjs drops wholly-blank rows on the way out, so the
  // fixture's blank second row is not in the grid. The index means
  // "row in the parsed grid", and every later step re-parses the file
  // through this same function, so it stays the same row.
  assertEquals(parsed.headerRowIndex, 1);
  assertEquals(parsed.skippedLeadingRows, 1);
  assertEquals(parsed.columns, ["Full Name", "Work E-Mail", "Start Date", "Department"]);
  assertEquals(parsed.rows.length, 3);

  // The date cell is a Date in the workbook and `YYYY-MM-DD` here, read
  // from LOCAL components. Reading it through toISOString() would move
  // it back a day for anyone east of Greenwich.
  assertEquals(parsed.rows[0][2], "2026-03-04");
  assertEquals(parsed.rows[1][2], "2026-04-01");
  assertEquals(parsed.rows[2][2], "2026-05-15");
});

Deno.test("parse: an empty cover sheet is skipped for the first sheet with data", () => {
  const parsed = parseSpreadsheet(fixture("two-sheets.xlsx"), { filename: "two-sheets.xlsx" });
  assertEquals(parsed.sheetName, "People");
  assertEquals(parsed.sheetNames, ["Cover", "People"]);
  assertEquals(parsed.columns, ["First Name", "Last Name", "Email"]);
});

Deno.test("parse: a named sheet can be asked for, and an unknown one is a 400", () => {
  const parsed = parseSpreadsheet(fixture("two-sheets.xlsx"), {
    filename: "two-sheets.xlsx",
    sheetName: "People",
  });
  assertEquals(parsed.sheetName, "People");

  const err = assertThrows(
    () =>
      parseSpreadsheet(fixture("two-sheets.xlsx"), {
        filename: "two-sheets.xlsx",
        sheetName: "Nope",
      }),
    BadRequestError,
  );
  assert(err.message.includes("Cover"), err.message);
});

Deno.test("parse: bytes that are not a workbook are a 400, not a 500", () => {
  // A ZIP magic number in front of rubbish: an .xlsx IS a zip, so this
  // gets past the format sniff and fails inside the reader, which is
  // the path a truncated or corrupt upload actually takes.
  const brokenZip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, ...text("not really a workbook")]);
  assertThrows(
    () => parseSpreadsheet(brokenZip, { filename: "x.xlsx" }),
    BadRequestError,
  );
});
