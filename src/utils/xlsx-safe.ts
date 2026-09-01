/**
 * Guarded access to `xlsx` -- ONE place, because the guard is a CVE fix.
 *
 * `xlsx@0.18.5` is exposed to CVE-2023-30533: a crafted workbook can
 * mutate `Object.prototype` while it is being parsed. The npm-published
 * 0.18.5 is the last release before the 0.19.3 fix, and that fix ships
 * only on cdn.sheetjs.com, so every parse in this app runs inside
 * `withPrototypeGuard`.
 *
 * The guard lives here, in `src/utils/`, rather than beside any one
 * caller. Two lanes read spreadsheets now -- inbound-email attachments
 * and the import wizard -- and a second copy of a CVE guard is a second
 * copy that can drift from the first. Import from here; do not
 * re-implement it.
 *
 * `src/services/inbound-email/xlsx.ts` re-exports both names so its
 * existing callers are unchanged.
 */

import * as XLSX from "xlsx";

/**
 * Wrap an XLSX parse in a prototype-pollution integrity check.
 *
 * Snapshots `Object.prototype`'s own-keys before invoking `fn`, then
 * re-checks afterwards. If the parse step mutated `Object.prototype`,
 * scrub every newly-added key and throw. Fail-closed -- better to reject
 * one workbook than to leave a polluted prototype affecting every
 * subsequent request in the process.
 */
export function withPrototypeGuard<T>(fn: () => T): T {
  const protoBefore = new Set(Object.getOwnPropertyNames(Object.prototype));
  let result!: T;
  const added: string[] = [];
  try {
    result = fn();
  } finally {
    const protoAfter = Object.getOwnPropertyNames(Object.prototype);
    for (const k of protoAfter) {
      if (!protoBefore.has(k)) added.push(k);
    }
    // Scrub any pollution regardless of how the try exited -- leaving the
    // prototype polluted would affect every other request handler in this
    // Deno process.
    for (const k of added) {
      try {
        delete (Object.prototype as Record<string, unknown>)[k];
      } catch {
        /* best-effort scrub; non-configurable props can't be deleted */
      }
    }
  }
  // Throw AFTER the finally (no-unsafe-finally): a throw inside finally
  // would mask a real error from fn(). If fn() threw, its error already
  // propagated and we never reach here.
  if (added.length > 0) {
    throw new Error(
      `Spreadsheet parse: workbook attempted to pollute Object.prototype ` +
        `(keys: ${added.join(", ")}). Refusing to ingest -- CVE-2023-30533.`,
    );
  }
  return result;
}

/**
 * Read a workbook from raw bytes, guarded.
 *
 * `cellDates: true` so a date cell arrives as a `Date` rather than as
 * Excel's serial number. Without it, a spreadsheet's start date reaches
 * the importer as `45658` and every date field in the file fails
 * validation for a reason nobody can act on.
 */
export function readWorkbook(bytes: Uint8Array): XLSX.WorkBook {
  return withPrototypeGuard(() => XLSX.read(bytes, { type: "array", cellDates: true }));
}

/**
 * Convert a spreadsheet (xls/xlsx) to text/CSV -- every sheet flattened
 * with a `# <sheetName>` header line.
 */
export function xlsxToCsv(bytes: Uint8Array): string {
  return withPrototypeGuard(() => {
    const wb = XLSX.read(bytes, { type: "array" });
    const parts: string[] = [];
    for (const name of wb.SheetNames) {
      const ws = wb.Sheets[name];
      if (!ws) continue;
      const csv = XLSX.utils.sheet_to_csv(ws);
      parts.push(`# ${name}\n${csv}`);
    }
    return parts.join("\n\n");
  });
}

/**
 * One sheet as a rectangular grid of RAW cell values (dates stay
 * `Date`, numbers stay `number`). `header: 1` asks sheetjs for arrays
 * rather than objects, which is what a wizard that has not decided on a
 * header row yet needs.
 */
export function sheetToGrid(sheet: XLSX.WorkSheet): unknown[][] {
  return withPrototypeGuard(() =>
    XLSX.utils.sheet_to_json<unknown[]>(sheet, {
      header: 1,
      raw: true,
      defval: "",
      blankrows: false,
    })
  );
}
