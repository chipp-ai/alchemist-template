/**
 * Spreadsheet -> CSV conversion for inbound-email attachments, with the
 * CVE-2023-30533 prototype-pollution guard. Ported from the Valor Victoria
 * customer repo (src/services/vv/email/extract.service.ts).
 *
 * The vision model cannot read binary xls/xlsx, so we flatten every sheet
 * to CSV text before inlining it into the LLM content.
 *
 * SECURITY: the bytes are an UNTRUSTED inbound-email attachment (anyone
 * can email the inbox). `xlsx@0.18.5` is exposed to CVE-2023-30533
 * (prototype pollution via a crafted workbook -- the npm-published 0.18.5
 * is the last release before the 0.19.3 fix that ships only on
 * cdn.sheetjs.com), so every parse runs inside `withPrototypeGuard` --
 * it detects + scrubs any `Object.prototype` mutation and fails closed.
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
      `xlsxToCsv: workbook attempted to pollute Object.prototype ` +
        `(keys: ${added.join(", ")}). Refusing to ingest -- CVE-2023-30533.`,
    );
  }
  return result;
}

/**
 * Convert a spreadsheet (xls/xlsx) to text/CSV -- every sheet flattened
 * with a `# <sheetName>` header line. `type: "array"` accepts the raw
 * Uint8Array bytes.
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
