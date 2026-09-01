/**
 * Spreadsheet parsing for the import wizard -- CSV and XLSX, one shape out.
 *
 * The wizard hands this module raw bytes and gets back a header row, a
 * list of column labels, and the data rows below the header, every cell
 * already text. Nothing above this layer knows which of the two formats
 * arrived.
 *
 * WHY CSV DOES NOT GO THROUGH SHEETJS
 *
 *   sheetjs will happily parse a CSV, and it type-guesses while it does:
 *   a zip code `01234` comes back as the number 1234, a part number
 *   `1-2E3` becomes 1200, and a date is re-formatted to whatever the
 *   sheet's locale implies. In a spreadsheet those guesses come from the
 *   cell's own declared format and are usually right. In a CSV there is
 *   no format, only text, so the guesses are just damage. The CSV path
 *   below is a plain RFC 4180 reader that preserves every character.
 *
 *   XLSX is the opposite case: the bytes are not text, the cell formats
 *   are real, and a date cell must come back as a `Date` or the importer
 *   sees Excel's serial number `45658`. That path uses sheetjs, through
 *   the shared CVE-2023-30533 guard in `src/utils/xlsx-safe.ts`.
 *
 * HEADER ROW DETECTION
 *
 *   Real exports lead with a title row, a blank row, a "generated on"
 *   stamp. `detectHeaderRow` scans the first `HEADER_SCAN_ROWS` rows and
 *   picks the widest mostly-textual one. Everything above it is reported
 *   as `skippedLeadingRows` rather than dropped silently, and the caller
 *   can override with an explicit index.
 */

import { BadRequestError } from "@/utils/errors.ts";
import { readWorkbook, sheetToGrid } from "@/utils/xlsx-safe.ts";
import { extensionOf, normalizeContentType } from "@/utils/upload-types.ts";

export type SpreadsheetFormat = "csv" | "xlsx";

/** How many leading rows are considered when looking for the header. */
export const HEADER_SCAN_ROWS = 10;

/**
 * Ceilings. A spreadsheet is attacker-supplied input like any other
 * upload: a 40 MB file that expands into a million-row grid would be
 * held in memory for the whole session. Both limits produce a message a
 * person can act on ("split the file"), never a 500.
 */
export const MAX_IMPORT_ROWS = 20_000;
export const MAX_IMPORT_COLUMNS = 200;

export interface ParsedSpreadsheet {
  format: SpreadsheetFormat;
  /** Sheet the rows came from. "" for a CSV. */
  sheetName: string;
  /** Every sheet in the workbook, so a caller can offer a picker. */
  sheetNames: string[];
  /** Index of the header row in the RAW grid. */
  headerRowIndex: number;
  /** Rows above the header that were not data. Reported, never hidden. */
  skippedLeadingRows: number;
  /** Column labels, de-duplicated and never blank. */
  columns: string[];
  /** Data rows below the header, each padded to `columns.length`. */
  rows: string[][];
}

export interface ParseOptions {
  /** Used only to choose the reader. The upload allowlist already ran. */
  filename?: string;
  contentType?: string;
  /** Pick a sheet by name. Defaults to the first non-empty one. */
  sheetName?: string;
  /** Override detection. Index into the raw grid. */
  headerRowIndex?: number;
}

// ── Entry point ────────────────────────────────────────────────────────────

export function parseSpreadsheet(
  bytes: Uint8Array,
  options: ParseOptions = {},
): ParsedSpreadsheet {
  if (bytes.length === 0) throw new BadRequestError("That file is empty.");

  const format = detectFormat(options);
  const { grid, sheetName, sheetNames } = format === "xlsx"
    ? readXlsxGrid(bytes, options.sheetName)
    : { grid: readCsvGrid(bytes), sheetName: "", sheetNames: [] };

  return shapeGrid(grid, { format, sheetName, sheetNames, headerRowIndex: options.headerRowIndex });
}

/**
 * Which reader to use.
 *
 * The extension decides, with the declared content type as the
 * tie-breaker for a file that arrived with no name. The upload allowlist
 * has already proven the two agree, so there is no third case to handle
 * here; an unknown pair is a CSV attempt, which fails with a readable
 * message rather than a guess.
 */
function detectFormat(options: ParseOptions): SpreadsheetFormat {
  const ext = extensionOf(options.filename ?? "");
  if (ext === ".xlsx" || ext === ".xls") return "xlsx";
  if (ext === ".csv") return "csv";

  const ct = normalizeContentType(options.contentType ?? "");
  if (ct.includes("spreadsheetml") || ct === "application/vnd.ms-excel") return "xlsx";
  return "csv";
}

// ── XLSX ───────────────────────────────────────────────────────────────────

function readXlsxGrid(
  bytes: Uint8Array,
  wanted?: string,
): { grid: string[][]; sheetName: string; sheetNames: string[] } {
  let workbook;
  try {
    workbook = readWorkbook(bytes);
  } catch (err) {
    // A corrupt workbook and a hostile one both land here. Neither is a
    // server fault, so neither is a 500.
    throw new BadRequestError(
      `That spreadsheet could not be read: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const sheetNames = workbook.SheetNames ?? [];
  if (sheetNames.length === 0) throw new BadRequestError("That workbook has no sheets.");

  if (wanted && !sheetNames.includes(wanted)) {
    throw new BadRequestError(
      `That workbook has no sheet named "${wanted}". It has: ${sheetNames.join(", ")}.`,
    );
  }

  // Default to the first sheet that actually holds something. A workbook
  // whose first tab is an empty cover sheet is common enough that
  // defaulting to "sheet 1" would send most of those imports to a blank
  // preview with nothing to explain it.
  const candidates = wanted ? [wanted] : sheetNames;
  for (const name of candidates) {
    const sheet = workbook.Sheets[name];
    if (!sheet) continue;
    const grid = sheetToGrid(sheet).map((row) => row.map(cellToText));
    if (grid.some((row) => row.some((cell) => cell !== ""))) {
      return { grid: trimGrid(grid), sheetName: name, sheetNames };
    }
  }

  throw new BadRequestError("Every sheet in that workbook is empty.");
}

/**
 * One cell to display text.
 *
 * Dates become `YYYY-MM-DD`, read from the date's LOCAL components, not
 * from `toISOString()`. sheetjs turns a date cell's serial number into a
 * `Date` built from local-time parts, so a cell reading 4 March becomes
 * midnight local on 4 March. In any timezone ahead of UTC that same
 * instant is 3 March in UTC, and `toISOString().slice(0, 10)` would
 * quietly move every date in the file back a day for anyone east of
 * Greenwich. Local getters undo exactly the convention that built it.
 */
function cellToText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return "";
    const pad = (n: number) => String(n).padStart(2, "0");
    const date = `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
    const hasTime = value.getHours() || value.getMinutes() || value.getSeconds();
    return hasTime
      ? `${date} ${pad(value.getHours())}:${pad(value.getMinutes())}:${pad(value.getSeconds())}`
      : date;
  }
  if (typeof value === "number") {
    // Long decimals print as exponents through String(); a spreadsheet
    // value never wants that.
    return Number.isInteger(value) ? String(value) : String(Number(value.toPrecision(15)));
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  return String(value);
}

// ── CSV ────────────────────────────────────────────────────────────────────

/**
 * RFC 4180, plus the two deviations every real file has: bare `\r\n` or
 * `\n` line endings mixed freely, and a UTF-8 BOM in front of the first
 * cell (Excel writes one on every "Save as CSV").
 */
export function parseCsv(text: string): string[][] {
  const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let sawAnyChar = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];

    if (quoted) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
      sawAnyChar = true;
      continue;
    }

    if (ch === '"') {
      quoted = true;
      sawAnyChar = true;
      continue;
    }
    if (ch === ",") {
      row.push(field);
      field = "";
      sawAnyChar = true;
      continue;
    }
    if (ch === "\r") {
      // Swallow the \n of a \r\n pair; a lone \r still ends the row.
      if (input[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      sawAnyChar = false;
      continue;
    }
    if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      sawAnyChar = false;
      continue;
    }

    field += ch;
    sawAnyChar = true;
  }

  // A trailing newline must not invent a final empty row, but a final
  // line with no newline after it must not be dropped.
  if (sawAnyChar || field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows;
}

function readCsvGrid(bytes: Uint8Array): string[][] {
  let text: string;
  try {
    // Fatal, so bytes that are not UTF-8 fail here with a message about
    // the encoding rather than reaching the mapper as replacement
    // characters and failing later as "this email address is invalid".
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new BadRequestError(
      "That CSV is not UTF-8 text. Re-export it as UTF-8 (or as .xlsx) and try again.",
    );
  }
  return trimGrid(parseCsv(text));
}

// ── Shaping ────────────────────────────────────────────────────────────────

/** Drop wholly-empty trailing rows and enforce the ceilings. */
function trimGrid(grid: string[][]): string[][] {
  let end = grid.length;
  while (end > 0 && grid[end - 1].every((cell) => cell.trim() === "")) end--;
  const trimmed = grid.slice(0, end);

  if (trimmed.length > MAX_IMPORT_ROWS + HEADER_SCAN_ROWS) {
    throw new BadRequestError(
      `That file has more than ${MAX_IMPORT_ROWS} rows. Split it and import each part.`,
    );
  }
  const widest = trimmed.reduce((max, row) => Math.max(max, row.length), 0);
  if (widest > MAX_IMPORT_COLUMNS) {
    throw new BadRequestError(
      `That file has more than ${MAX_IMPORT_COLUMNS} columns. Remove the ones you do not need.`,
    );
  }
  return trimmed;
}

function shapeGrid(
  grid: string[][],
  meta: {
    format: SpreadsheetFormat;
    sheetName: string;
    sheetNames: string[];
    headerRowIndex?: number;
  },
): ParsedSpreadsheet {
  if (grid.length === 0) throw new BadRequestError("That file has no rows.");

  const headerRowIndex = meta.headerRowIndex ?? detectHeaderRow(grid);
  if (headerRowIndex < 0 || headerRowIndex >= grid.length) {
    throw new BadRequestError(`Row ${headerRowIndex + 1} is not in that file.`);
  }

  const columns = labelColumns(grid[headerRowIndex]);
  if (columns.length === 0) {
    throw new BadRequestError("The header row of that file is empty.");
  }

  const rows: string[][] = [];
  for (let i = headerRowIndex + 1; i < grid.length; i++) {
    const raw = grid[i];
    if (raw.every((cell) => cell.trim() === "")) continue; // blank separator row
    const padded: string[] = [];
    for (let c = 0; c < columns.length; c++) padded.push((raw[c] ?? "").trim());
    rows.push(padded);
  }

  if (rows.length > MAX_IMPORT_ROWS) {
    throw new BadRequestError(
      `That file has ${rows.length} data rows, more than the ${MAX_IMPORT_ROWS} limit. ` +
        `Split it and import each part.`,
    );
  }

  return {
    format: meta.format,
    sheetName: meta.sheetName,
    sheetNames: meta.sheetNames,
    headerRowIndex,
    skippedLeadingRows: headerRowIndex,
    columns,
    rows,
  };
}

/**
 * Which row is the header.
 *
 * Score = filled cells, minus a penalty for each cell that is purely a
 * number. A header is wide and worded; a data row that happens to sit
 * above the header (it does not, but a title row does) is narrow, and a
 * numeric row is never a header. Ties go to the earliest row, so a file
 * whose header and first data row are the same width picks the header.
 *
 * This is structural, not semantic: it counts cells, it does not try to
 * read what a column "means".
 */
export function detectHeaderRow(grid: string[][]): number {
  const limit = Math.min(grid.length, HEADER_SCAN_ROWS);
  let bestIndex = 0;
  let bestScore = -Infinity;

  for (let i = 0; i < limit; i++) {
    const cells = grid[i].map((c) => c.trim());
    const filled = cells.filter((c) => c !== "").length;
    if (filled === 0) continue;
    const numeric = cells.filter((c) => c !== "" && isPlainNumber(c)).length;
    // A single-cell row is a title, not a header, however wordy it is.
    const score = filled < 2 ? filled - 5 : filled * 2 - numeric * 3;
    if (score > bestScore) {
      bestScore = score;
      bestIndex = i;
    }
  }

  return bestIndex;
}

function isPlainNumber(value: string): boolean {
  return /^-?\d+(\.\d+)?$/.test(value.replace(/[,\s]/g, ""));
}

/**
 * Column labels the mapper can address.
 *
 * A blank header cell becomes `Column N` (people leave one blank all the
 * time) and a repeated label gets a numeric suffix, because the mapping
 * is keyed by column INDEX and a duplicate label would make the mapping
 * screen ambiguous to read even though the data underneath is fine.
 */
function labelColumns(headerRow: string[]): string[] {
  // Trailing blank header cells are not columns.
  let end = headerRow.length;
  while (end > 0 && (headerRow[end - 1] ?? "").trim() === "") end--;

  const seen = new Map<string, number>();
  const labels: string[] = [];
  for (let i = 0; i < end; i++) {
    const base = (headerRow[i] ?? "").trim() || `Column ${i + 1}`;
    const count = seen.get(base.toLowerCase()) ?? 0;
    seen.set(base.toLowerCase(), count + 1);
    labels.push(count === 0 ? base : `${base} (${count + 1})`);
  }
  return labels;
}
