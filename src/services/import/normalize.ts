/**
 * Cell and row normalization -- text in, typed values plus honest errors out.
 *
 * Every value a spreadsheet produces is text, and every one of them is
 * somebody's habit: `  Ana  `, `ANA@WORK.COM `, `3/4/26`, `Yes`, `1,250`.
 * This module turns those into the value the app stores, or into an
 * error naming the cell and what is wrong with it. It never guesses and
 * it never silently drops: a value it cannot read becomes a row error
 * the person sees in the preview, beside the row it came from.
 *
 * The regexes here are deliberate. They read STRUCTURED input, which is
 * exactly what a regex is for: an email's syntax, a date's shape, a
 * yes/no vocabulary we define. Nothing here tries to interpret prose.
 */

import type {
  ImportDefinition,
  ImportFieldSpec,
  ImportRowValues,
  ImportValue,
} from "./definitions.ts";
import { fieldsByKey } from "./definitions.ts";

export interface CellError {
  field: string;
  /** The field's label, so a UI does not have to look it up. */
  label: string;
  message: string;
}

export interface NormalizedRow {
  /** Field key -> value. `inputOnly` keys are removed. */
  values: ImportRowValues;
  /** Every value including `inputOnly`, for identity matching and display. */
  allValues: ImportRowValues;
  /** Columns mapped to "custom", keyed by the name the person gave. */
  extras: Record<string, string>;
  errors: CellError[];
}

/** The default ceiling for a text cell, so one runaway cell cannot bloat a row. */
export const DEFAULT_TEXT_MAX = 500;

// ── One cell ───────────────────────────────────────────────────────────────

export function normalizeCell(
  field: ImportFieldSpec,
  raw: string | null | undefined,
): { value: ImportValue; error: string | null } {
  const text = (raw ?? "").trim();
  if (text === "") return { value: null, error: null };

  switch (field.kind) {
    case "text":
      return normalizeText(field, text);
    case "email":
      return normalizeEmail(field, text);
    case "date":
      return normalizeDate(field, text);
    case "number":
      return normalizeNumber(text);
    case "boolean":
      return normalizeBoolean(text);
    case "enum":
      return normalizeEnum(field, text);
  }
}

function normalizeText(
  field: ImportFieldSpec,
  text: string,
): { value: ImportValue; error: string | null } {
  const collapsed = text.replace(/\s+/g, " ");
  const max = field.maxLength ?? DEFAULT_TEXT_MAX;
  if (collapsed.length > max) {
    // Refused, not truncated. A silently shortened value is a wrong
    // value that nobody ever finds.
    return {
      value: null,
      error: `is longer than ${max} characters (${collapsed.length}).`,
    };
  }
  return { value: collapsed, error: null };
}

/**
 * Email syntax, not deliverability.
 *
 * One `@`, something either side, a dot in the domain, no whitespace and
 * no comma (a comma means two addresses in one cell, which is a real and
 * common mistake worth naming). Anything stricter rejects addresses that
 * work; anything looser accepts `n/a` and `none`.
 */
const EMAIL_RE = /^[^\s@,;<>"]+@[^\s@,;<>".]+\.[^\s@,;<>"]{2,}$/;

function normalizeEmail(
  field: ImportFieldSpec,
  text: string,
): { value: ImportValue; error: string | null } {
  const value = text.toLowerCase();
  if (value.includes(",") || value.includes(";")) {
    return { value: null, error: `looks like more than one address: "${text}".` };
  }
  if (!EMAIL_RE.test(value)) {
    return { value: null, error: `is not an email address: "${text}".` };
  }
  const max = field.maxLength ?? 320;
  if (value.length > max) {
    return { value: null, error: `is longer than ${max} characters.` };
  }
  return { value, error: null };
}

const MONTHS: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  sept: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

/**
 * A date, always stored as `YYYY-MM-DD`.
 *
 * Four shapes are accepted, and the fourth is the interesting one:
 *
 *   2026-03-04            ISO. Unambiguous.
 *   2026/03/04            ISO with slashes. Unambiguous.
 *   4 Mar 2026            month by name, either order. Unambiguous.
 *   3/4/2026              ambiguous, and the file cannot tell you which
 *                         it is. The DEFINITION says, via `dateOrder`.
 *                         Month-first unless it declares otherwise.
 *
 * A day or month out of range is an error, not a rollover: JavaScript
 * would happily read `2026-02-30` as March 2nd, and an import that
 * quietly moves somebody's start date is worse than one that stops.
 */
function normalizeDate(
  field: ImportFieldSpec,
  text: string,
): { value: ImportValue; error: string | null } {
  const bad = { value: null, error: `is not a date we can read: "${text}".` };
  // Drop a time component: a date column with 00:00:00 on the end is
  // just a date, and a real time in a date field is not ours to keep.
  const body = text.split(/[T ]/)[0].trim();

  let year: number, month: number, day: number;

  const iso = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(body);
  const named = parseNamedMonth(text.trim());
  const numeric = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/.exec(body);

  if (iso) {
    year = Number(iso[1]);
    month = Number(iso[2]);
    day = Number(iso[3]);
  } else if (named) {
    ({ year, month, day } = named);
  } else if (numeric) {
    const a = Number(numeric[1]);
    const b = Number(numeric[2]);
    year = expandYear(Number(numeric[3]));
    if ((field.dateOrder ?? "mdy") === "dmy") {
      day = a;
      month = b;
    } else {
      month = a;
      day = b;
    }
  } else {
    return bad;
  }

  if (month < 1 || month > 12) return bad;
  if (day < 1 || day > daysInMonth(year, month)) return bad;
  if (year < 1900 || year > 2200) return bad;

  const pad = (n: number) => String(n).padStart(2, "0");
  return { value: `${year}-${pad(month)}-${pad(day)}`, error: null };
}

/**
 * "4 Mar 2026", "4-Mar-26", "Mar 4, 2026" -- both orders, because a
 * named month makes the order unambiguous whichever end it sits at.
 */
function parseNamedMonth(text: string): { year: number; month: number; day: number } | null {
  const dayFirst = /^(\d{1,2})[\s-]([A-Za-z]{3,9})\.?[\s-](\d{2,4})$/.exec(text);
  const monthFirst = /^([A-Za-z]{3,9})\.?[\s-](\d{1,2}),?[\s-]?\s*(\d{2,4})$/.exec(text);

  const parts = dayFirst
    ? { day: dayFirst[1], name: dayFirst[2], year: dayFirst[3] }
    : monthFirst
    ? { day: monthFirst[2], name: monthFirst[1], year: monthFirst[3] }
    : null;
  if (!parts) return null;

  const name = parts.name.toLowerCase();
  const month = MONTHS[name.slice(0, 4)] ?? MONTHS[name.slice(0, 3)];
  if (!month) return null;

  return { year: expandYear(Number(parts.year)), month, day: Number(parts.day) };
}

/** Two-digit years: 00-69 is this century, 70-99 the last. The POSIX rule. */
function expandYear(year: number): number {
  if (year >= 100) return year;
  return year < 70 ? 2000 + year : 1900 + year;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function normalizeNumber(text: string): { value: ImportValue; error: string | null } {
  // Thousands separators and a currency symbol are formatting, not data.
  const cleaned = text.replace(/[,\s]/g, "").replace(/^[$£€]/, "");
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) {
    return { value: null, error: `is not a number: "${text}".` };
  }
  return { value: Number(cleaned), error: null };
}

/**
 * A fixed vocabulary we define, so matching it by string is exactly
 * right. Anything outside it is an error rather than a coin flip: a cell
 * reading "pending" is not a no.
 */
const TRUTHY = new Set(["true", "yes", "y", "1", "x", "on", "t"]);
const FALSY = new Set(["false", "no", "n", "0", "off", "f", "-"]);

function normalizeBoolean(text: string): { value: ImportValue; error: string | null } {
  const key = text.toLowerCase();
  if (TRUTHY.has(key)) return { value: true, error: null };
  if (FALSY.has(key)) return { value: false, error: null };
  return { value: null, error: `is not a yes or a no: "${text}".` };
}

function normalizeEnum(
  field: ImportFieldSpec,
  text: string,
): { value: ImportValue; error: string | null } {
  const options = field.options ?? [];
  const wanted = squash(text);
  const hit = options.find((option) => squash(option) === wanted);
  if (!hit) {
    return {
      value: null,
      error: `is not one of ${options.join(", ")}: "${text}".`,
    };
  }
  // The DEFINITION's spelling is stored, never the file's.
  return { value: hit, error: null };
}

/** Case, space and punctuation removed. Used for enum and header matching. */
export function squash(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

// ── One row ────────────────────────────────────────────────────────────────

/**
 * Normalize, derive, then check required-ness. That order matters: a
 * required `firstName` filled by splitting a "Full name" column is
 * satisfied, and it would not be if required-ness ran first.
 */
export function normalizeRow(
  def: ImportDefinition,
  input: { cells: Record<string, string>; extras?: Record<string, string> },
): NormalizedRow {
  const fields = fieldsByKey(def);
  const values: ImportRowValues = {};
  const errors: CellError[] = [];

  for (const field of def.fields) {
    const raw = input.cells[field.key];
    // A field nobody mapped is absent, not empty-and-wrong. The
    // required check below is what speaks to that.
    if (raw === undefined) {
      values[field.key] = null;
      continue;
    }
    const { value, error } = normalizeCell(field, raw);
    values[field.key] = value;
    if (error) errors.push({ field: field.key, label: field.label, message: error });
  }

  for (const derivation of def.derive ?? []) {
    // Skip a derivation whose inputs are all empty: it has nothing to
    // work from and would only overwrite good values with nulls.
    if (derivation.from.every((key) => isBlank(values[key]))) continue;

    let produced: ImportRowValues;
    try {
      produced = derivation.run({ ...values });
    } catch (err) {
      errors.push({
        field: derivation.produces[0] ?? "row",
        label: fields.get(derivation.produces[0] ?? "")?.label ?? "Row",
        message: `could not be derived: ${err instanceof Error ? err.message : String(err)}`,
      });
      continue;
    }

    for (const [key, produce] of Object.entries(produced)) {
      // An explicit column ALWAYS beats a derived value. Somebody who
      // supplied a "First name" column meant it.
      if (!isBlank(values[key])) continue;
      const field = fields.get(key);
      if (!field) continue;
      const { value, error } = normalizeCell(
        field,
        produce === null || produce === undefined ? "" : String(produce),
      );
      values[key] = value;
      if (error) errors.push({ field: key, label: field.label, message: error });
    }
  }

  for (const field of def.fields) {
    if (!field.required) continue;
    if (isBlank(values[field.key])) {
      // Only say "is required" once per field, even if the cell also
      // failed to parse. Two errors for one cell reads as two problems.
      if (!errors.some((e) => e.field === field.key)) {
        errors.push({ field: field.key, label: field.label, message: "is required." });
      }
    }
  }

  const target: ImportRowValues = {};
  for (const field of def.fields) {
    if (field.inputOnly) continue;
    target[field.key] = values[field.key] ?? null;
  }

  return { values: target, allValues: values, extras: input.extras ?? {}, errors };
}

export function isBlank(value: ImportValue | undefined): boolean {
  if (value === null || value === undefined) return true;
  return typeof value === "string" && value.trim() === "";
}
