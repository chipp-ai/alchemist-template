/**
 * Spreadsheet -> CSV conversion for inbound-email attachments.
 *
 * The vision model cannot read binary xls/xlsx, so we flatten every sheet
 * to CSV text before inlining it into the LLM content.
 *
 * The parse itself, and the CVE-2023-30533 prototype-pollution guard
 * around it, now live in `src/utils/xlsx-safe.ts` -- the import wizard
 * reads spreadsheets too, and a second copy of a CVE guard is a second
 * copy that can drift. This module re-exports both names so existing
 * callers here are unchanged.
 */

export { withPrototypeGuard, xlsxToCsv } from "@/utils/xlsx-safe.ts";
