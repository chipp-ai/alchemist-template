/**
 * Import sessions -- the four-step wizard, server side.
 *
 *   upload   store the file on the uploads paved road, parse it, propose
 *            a column mapping, open a session
 *   map      record the person's corrections to that proposal
 *   preview  normalize every row, count creates against updates, name
 *            every row that will not land and say why
 *   commit   one transaction, the definition's own upsert per row, and
 *            an honest account of what happened
 *
 * TWO PROMISES THIS MODULE KEEPS, because breaking either is how a
 * customer ends up re-typing a spreadsheet by hand:
 *
 * NO ROW IS EVER SILENTLY DROPPED. Every row that does not become a
 * record appears in the result with its row number and a reason a person
 * can act on. A count is a summary, never the whole answer.
 *
 * A RE-IMPORT UPDATES. The definition's `matchBy` decides which rows are
 * already records, and it decides it the same way in the preview and in
 * the commit, from one shared preparation step. A preview that says "12
 * updates" and a commit that creates 12 duplicates is the bug this
 * shared step exists to make impossible.
 *
 * THE COMMIT IS ALL OR NOTHING. Rows that fail validation, or duplicate
 * an earlier row in the same file, are excluded BEFORE the transaction
 * opens and reported as skipped. If the definition's own upsert then
 * throws, the whole transaction rolls back and nothing landed. A
 * half-applied spreadsheet is worse than one that did not import: you
 * cannot tell which half. Because identity matching makes a re-run an
 * update, fixing the file and importing it again is always safe.
 */

import { db, withTimeout } from "@/db/client.ts";
import type { ImportSessionRow, ImportSessionStatus } from "@/db/schema.ts";
import { log } from "@/lib/logger.ts";
import { BadRequestError, ConflictError, NotFoundError } from "@/utils/errors.ts";
import { getObject } from "@/services/storage.service.ts";
import { getUploadedFile, storeUploadedFile } from "@/services/uploaded-file.service.ts";
import {
  definitionUploadTypes,
  getImportDefinition,
  type ImportDefinition,
  type ImportRowValues,
} from "./definitions.ts";
import { type ParsedSpreadsheet, parseSpreadsheet } from "./parse.ts";
import { assertAllowedUpload } from "@/utils/upload-types.ts";
import {
  buildIdentityIndex,
  type ColumnMappingEntry,
  type ColumnProposal,
  identityKeys,
  proposeMapping,
  resolveMapping,
  rowCells,
} from "./mapping.ts";
import { type CellError, normalizeRow } from "./normalize.ts";

const LOG_SOURCE = "imports";

/** Rows shown in the preview table. Counts always cover the whole file. */
export const PREVIEW_ROW_LIMIT = 25;

/**
 * How many problem rows the stored result lists individually. Above
 * this, the count is still exact and `unlistedProblemRows` says how many
 * are missing: a result row is a few hundred bytes, and a wholly broken
 * 20k-row file must not write a 10 MB JSONB value.
 */
export const MAX_LISTED_PROBLEM_ROWS = 1000;

/** Wall clock for the commit transaction. */
export const COMMIT_TIMEOUT_MS = 120_000;

// ── Session shape ──────────────────────────────────────────────────────────

export interface ImportSession {
  id: string;
  organizationId: string;
  createdBy: string | null;
  definitionName: string;
  uploadedFileId: string | null;
  filename: string;
  status: ImportSessionStatus;
  sheetName: string | null;
  headerRowIndex: number;
  columns: string[];
  mapping: ColumnMappingEntry[];
  rowCount: number;
  result: ImportResult | null;
  committedAt: Date | null;
  createdAt: Date;
}

export type RowOutcome = "created" | "updated" | "skipped" | "failed";

export interface ImportResultRow {
  /** 1-based data row, counting from the first row under the header. */
  rowNumber: number;
  outcome: RowOutcome;
  /** Why it did not land. Always set for skipped and failed. */
  reason: string | null;
  /** The record it became. Set for created and updated. */
  recordId: string | null;
}

export interface ImportResult {
  created: number;
  updated: number;
  skipped: number;
  failed: number;
  /** Every row that did NOT become a record, named. Capped; see below. */
  problemRows: ImportResultRow[];
  /** How many problem rows the cap left out. Zero in every normal run. */
  unlistedProblemRows: number;
  /** Set when the transaction rolled back, so nothing at all landed. */
  rolledBack: boolean;
  /** The failure that rolled it back, if any. */
  error: string | null;
}

// ── Preparation (shared by preview and commit) ─────────────────────────────

export type RowAction = "create" | "update" | "skip";

export interface PreparedRow {
  rowNumber: number;
  action: RowAction;
  /** Values that reach `upsertRow`. */
  values: ImportRowValues;
  /** Including `inputOnly` fields, for display and identity matching. */
  allValues: ImportRowValues;
  extras: Record<string, string>;
  errors: CellError[];
  existingId: string | null;
  /** The earlier row in this same file that already claimed this identity. */
  duplicateOfRow: number | null;
}

export interface PreparedImport {
  definition: ImportDefinition;
  rows: PreparedRow[];
  counts: {
    total: number;
    create: number;
    update: number;
    /** Rows with at least one validation error. */
    invalid: number;
    /** Rows whose identity already appeared earlier in the same file. */
    duplicate: number;
  };
}

/**
 * Normalize every row, resolve every identity, decide every action.
 *
 * ONE function, called by both the preview and the commit, so what a
 * person is shown is literally what runs.
 */
export async function prepareImport(opts: {
  definition: ImportDefinition;
  organizationId: string;
  columns: readonly string[];
  rows: readonly string[][];
  mapping: readonly ColumnMappingEntry[];
}): Promise<PreparedImport> {
  const { definition } = opts;
  const resolved = resolveMapping(opts.mapping, opts.columns, definition);
  if (resolved.errors.length > 0) {
    throw new BadRequestError(resolved.errors.join(" "));
  }

  const normalized = opts.rows.map((row, index) => {
    const { cells, extras } = rowCells(row, resolved.byColumn);
    return { rowNumber: index + 1, ...normalizeRow(definition, { cells, extras }) };
  });

  // Only valid rows are offered to the app's lookup: an unparseable
  // email is not an identity, and handing it over would invite a WHERE
  // clause on garbage.
  const lookupRows = normalized.filter((r) => r.errors.length === 0).map((r) => r.allValues);
  const existing = lookupRows.length > 0
    ? await definition.loadExisting({ organizationId: opts.organizationId, rows: lookupRows })
    : [];
  const index = buildIdentityIndex(existing, definition.matchBy);

  // Claimed inside the file, so the second row for one person is a
  // duplicate rather than a second write that quietly wins.
  const claimed = new Map<string, number>();
  const rows: PreparedRow[] = [];
  const counts = { total: normalized.length, create: 0, update: 0, invalid: 0, duplicate: 0 };

  for (const row of normalized) {
    if (row.errors.length > 0) {
      counts.invalid++;
      rows.push({ ...row, action: "skip", existingId: null, duplicateOfRow: null });
      continue;
    }

    const keys = identityKeys(row.allValues, definition.matchBy);
    const duplicateOfRow = keys.map((key) => claimed.get(key)).find((n) => n !== undefined) ?? null;
    if (duplicateOfRow !== null) {
      counts.duplicate++;
      rows.push({ ...row, action: "skip", existingId: null, duplicateOfRow });
      continue;
    }
    for (const key of keys) if (!claimed.has(key)) claimed.set(key, row.rowNumber);

    const existingId = index.lookup(row.allValues);
    if (existingId) counts.update++;
    else counts.create++;
    rows.push({
      ...row,
      action: existingId ? "update" : "create",
      existingId,
      duplicateOfRow: null,
    });
  }

  return { definition, rows, counts };
}

/** The sentence a person reads next to a row that will not land. */
export function skipReason(row: PreparedRow): string {
  if (row.duplicateOfRow !== null) {
    return `Row ${row.duplicateOfRow} is the same record. Only the first one is imported.`;
  }
  if (row.errors.length > 0) {
    return row.errors.map((e) => `${e.label} ${e.message}`).join(" ");
  }
  return "Not imported.";
}

// ── Creating a session ─────────────────────────────────────────────────────

export interface CreateImportSessionInput {
  organizationId: string;
  userId: string | null;
  definitionName: string;
  filename: string;
  contentType: string;
  body: Uint8Array;
  /** Pick a sheet in a multi-sheet workbook. */
  sheetName?: string;
  /** Override header detection. Index into the raw grid. */
  headerRowIndex?: number;
}

export async function createImportSession(
  input: CreateImportSessionInput,
): Promise<{ session: ImportSession; proposal: ColumnProposal[] }> {
  const definition = getImportDefinition(input.definitionName);

  // Parse BEFORE storing. A file the wizard cannot read should not leave
  // an orphan object and a dead session behind it.
  const parsed = parseSpreadsheet(input.body, {
    filename: input.filename,
    contentType: input.contentType,
    sheetName: input.sheetName,
    headerRowIndex: input.headerRowIndex,
  });

  // The uploads paved road: its allowlist, its server-picked key, its
  // row. `allow` narrows to what this definition takes, and `approved`
  // because an import file is not the kind of upload a human reviews --
  // the preview screen IS its review.
  const file = await storeUploadedFile({
    organizationId: input.organizationId,
    uploadedByUserId: input.userId,
    filename: input.filename,
    contentType: input.contentType,
    body: input.body,
    subjectType: "import",
    subjectId: definition.name,
    allow: definitionUploadTypes(definition),
    status: "approved",
  });

  const proposal = proposeMapping(parsed.columns, definition);
  const session = await insertSession({
    organizationId: input.organizationId,
    userId: input.userId,
    definition,
    uploadedFileId: file.id,
    filename: file.filename,
    parsed,
    proposal,
  });

  return { session, proposal };
}

/** The session row. Shared by both ways of opening one. */
async function insertSession(input: {
  organizationId: string;
  userId: string | null;
  definition: ImportDefinition;
  uploadedFileId: string;
  filename: string;
  parsed: ParsedSpreadsheet;
  proposal: ColumnProposal[];
}): Promise<ImportSession> {
  const row = await db
    .insertInto("import_sessions")
    .values({
      organizationId: input.organizationId,
      createdBy: input.userId,
      definitionName: input.definition.name,
      uploadedFileId: input.uploadedFileId,
      filename: input.filename,
      status: "parsed",
      sheetName: input.parsed.sheetName || null,
      headerRowIndex: input.parsed.headerRowIndex,
      // Plain objects. postgres.js serializes a jsonb parameter itself,
      // so a value pre-encoded by the caller lands as a jsonb string
      // scalar and every structural read of it later detonates.
      columns: input.parsed.columns,
      mapping: proposalToMapping(input.proposal),
      rowCount: input.parsed.rows.length,
    })
    .returningAll()
    .executeTakeFirstOrThrow();

  log.info("Import session opened", {
    source: LOG_SOURCE,
    feature: "create",
    sessionId: row.id,
    organizationId: input.organizationId,
    definition: input.definition.name,
    rows: input.parsed.rows.length,
    columns: input.parsed.columns.length,
    format: input.parsed.format,
  });

  return toImportSession(row);
}

/**
 * Open a session on a file that is ALREADY on the uploads paved road.
 *
 * This is the path the wizard takes. `<UploadField>` posts the file to
 * `/api/files/uploads` exactly as it does everywhere else in the app,
 * and the wizard then hands the resulting id here. The alternative,
 * a second upload endpoint with its own progress bar and its own
 * allowlist, is the duplication the uploads paved road exists to
 * prevent.
 *
 * The TYPE IS RE-CHECKED here. `/api/files/uploads` enforces the app's
 * whole allowlist, which is wider than one import's `allow`, so a PDF
 * can be a legitimate upload and still not be a spreadsheet. Refusing it
 * here is what keeps a definition's narrowing real.
 */
export async function createImportSessionFromUpload(input: {
  organizationId: string;
  userId: string | null;
  definitionName: string;
  uploadedFileId: string;
  sheetName?: string;
  headerRowIndex?: number;
}): Promise<{ session: ImportSession; proposal: ColumnProposal[] }> {
  const definition = getImportDefinition(input.definitionName);

  // Org-scoped read: another workspace's file id is a 404 (CWE-639).
  const file = await getUploadedFile({
    id: input.uploadedFileId,
    organizationId: input.organizationId,
  });

  assertAllowedUpload(
    { filename: file.filename, contentType: file.contentType, sizeBytes: file.sizeBytes },
    { allow: definitionUploadTypes(definition) },
  );

  const object = await getObject(file.storageKey);
  const parsed = parseSpreadsheet(object.body, {
    filename: file.filename,
    contentType: file.contentType,
    sheetName: input.sheetName,
    headerRowIndex: input.headerRowIndex,
  });

  const proposal = proposeMapping(parsed.columns, definition);
  const session = await insertSession({
    organizationId: input.organizationId,
    userId: input.userId,
    definition,
    uploadedFileId: file.id,
    filename: file.filename,
    parsed,
    proposal,
  });

  return { session, proposal };
}

/** The proposal as a mapping the client can send straight back. */
export function proposalToMapping(proposal: readonly ColumnProposal[]): ColumnMappingEntry[] {
  return proposal.map((p) => ({
    columnIndex: p.columnIndex,
    fieldKey: p.fieldKey,
    custom: null,
  }));
}

// ── Reading a session ──────────────────────────────────────────────────────

export async function getImportSession(opts: {
  id: string;
  organizationId: string;
}): Promise<ImportSession> {
  const row = await db
    .selectFrom("import_sessions")
    .selectAll()
    .where("id", "=", opts.id)
    // Org-scoped in the WHERE clause. Another workspace's session id is
    // a 404, not a cross-tenant read (CWE-639).
    .where("organizationId", "=", opts.organizationId)
    .executeTakeFirst();

  if (!row) throw new NotFoundError("Import session");
  return toImportSession(row);
}

export async function listImportSessions(opts: {
  organizationId: string;
  definitionName?: string;
  limit?: number;
}): Promise<ImportSession[]> {
  let query = db
    .selectFrom("import_sessions")
    .selectAll()
    .where("organizationId", "=", opts.organizationId);

  if (opts.definitionName) query = query.where("definitionName", "=", opts.definitionName);

  const rows = await query
    .orderBy("createdAt", "desc")
    .limit(Math.min(Math.max(opts.limit ?? 20, 1), 100))
    .execute();

  return rows.map(toImportSession);
}

// ── Mapping ────────────────────────────────────────────────────────────────

export async function setImportSessionMapping(opts: {
  id: string;
  organizationId: string;
  entries: readonly ColumnMappingEntry[];
}): Promise<ImportSession> {
  const session = await getImportSession(opts);
  assertNotCommitted(session);
  const definition = getImportDefinition(session.definitionName);

  // Validate against the file's own columns before storing. A mapping
  // that cannot be resolved is a mapping the preview would reject a
  // moment later with the person's choices already lost.
  const resolved = resolveMapping(opts.entries, session.columns, definition);
  if (resolved.errors.length > 0) throw new BadRequestError(resolved.errors.join(" "));

  const row = await db
    .updateTable("import_sessions")
    .set({ mapping: [...opts.entries], status: "mapped" })
    .where("id", "=", opts.id)
    .where("organizationId", "=", opts.organizationId)
    .returningAll()
    .executeTakeFirstOrThrow();

  return toImportSession(row);
}

// ── Preview ────────────────────────────────────────────────────────────────

export interface ImportPreviewRow {
  rowNumber: number;
  action: RowAction;
  values: ImportRowValues;
  errors: CellError[];
  duplicateOfRow: number | null;
  reason: string | null;
}

export interface ImportPreview {
  sessionId: string;
  definitionName: string;
  columns: string[];
  mapping: ColumnMappingEntry[];
  counts: PreparedImport["counts"];
  /** The first `limit` rows, in file order. */
  rows: ImportPreviewRow[];
  /**
   * Rows that will NOT land, wherever they are in the file. Shown in
   * full alongside the sample above, because a broken row on line 900 is
   * exactly the one a person needs to see before committing.
   */
  problemRows: ImportPreviewRow[];
  unlistedProblemRows: number;
}

export async function previewImportSession(opts: {
  id: string;
  organizationId: string;
  limit?: number;
}): Promise<ImportPreview> {
  const session = await getImportSession(opts);
  const prepared = await prepareForSession(session);
  const limit = Math.min(Math.max(opts.limit ?? PREVIEW_ROW_LIMIT, 1), 200);

  const problems = prepared.rows.filter((r) => r.action === "skip");

  return {
    sessionId: session.id,
    definitionName: session.definitionName,
    columns: session.columns,
    mapping: session.mapping,
    counts: prepared.counts,
    rows: prepared.rows.slice(0, limit).map(toPreviewRow),
    problemRows: problems.slice(0, MAX_LISTED_PROBLEM_ROWS).map(toPreviewRow),
    unlistedProblemRows: Math.max(0, problems.length - MAX_LISTED_PROBLEM_ROWS),
  };
}

function toPreviewRow(row: PreparedRow): ImportPreviewRow {
  return {
    rowNumber: row.rowNumber,
    action: row.action,
    values: row.allValues,
    errors: row.errors,
    duplicateOfRow: row.duplicateOfRow,
    reason: row.action === "skip" ? skipReason(row) : null,
  };
}

// ── Commit ─────────────────────────────────────────────────────────────────

export async function commitImportSession(opts: {
  id: string;
  organizationId: string;
  userId: string | null;
}): Promise<{ session: ImportSession; result: ImportResult }> {
  const session = await getImportSession(opts);
  // Committing twice would double the creates, and identity matching
  // cannot save a row that has no identity tuple filled. A committed
  // session is finished; a re-run starts a new one.
  if (session.status === "committed") {
    throw new ConflictError("This import has already been committed.");
  }

  const prepared = await prepareForSession(session);
  const toWrite = prepared.rows.filter((r) => r.action !== "skip");
  const skipped = prepared.rows.filter((r) => r.action === "skip");

  if (toWrite.length === 0) {
    // Nothing to write is not a failure, and it is certainly not a
    // silent success: the result still names every row and why.
    const result = buildResult({ written: [], skipped, rolledBack: false, error: null });
    return { session: await storeResult(session, result, "committed"), result };
  }

  const written: Array<{ row: PreparedRow; recordId: string }> = [];
  // A holder rather than two `let`s: the assignment happens inside the
  // transaction callback, which TypeScript cannot follow, so a plain
  // `let` would still be narrowed to `null` in the catch below.
  const failure: { rowNumber: number | null; message: string | null } = {
    rowNumber: null,
    message: null,
  };

  try {
    await withTimeout(COMMIT_TIMEOUT_MS, async (trx) => {
      for (const row of toWrite) {
        try {
          const { id } = await prepared.definition.upsertRow({
            trx,
            organizationId: session.organizationId,
            userId: opts.userId,
            values: row.values,
            extras: row.extras,
            existingId: row.existingId,
            rowNumber: row.rowNumber,
          });
          written.push({ row, recordId: id });
        } catch (err) {
          failure.rowNumber = row.rowNumber;
          failure.message = err instanceof Error ? err.message : String(err);
          // Rethrow so the transaction rolls back. Catching per row and
          // carrying on would leave the file half applied inside a
          // transaction that then commits the half.
          throw err;
        }
      }
    });
  } catch (err) {
    const message = failure.message ?? (err instanceof Error ? err.message : String(err));

    const result = buildResult({
      written: [],
      skipped,
      rolledBack: true,
      error: message,
      // Everything that was going to be written is reported, the row
      // that broke as failed and the rest as not-attempted. Nothing
      // landed, and the result says so on every row.
      rolledBackRows: toWrite,
      failedRowNumber: failure.rowNumber,
    });

    log.error("Import rolled back", {
      source: LOG_SOURCE,
      feature: "commit",
      sessionId: session.id,
      organizationId: session.organizationId,
      definition: session.definitionName,
      failedRow: failure.rowNumber,
      attempted: toWrite.length,
    }, err instanceof Error ? err : new Error(String(err)));

    return { session: await storeResult(session, result, "failed"), result };
  }

  const result = buildResult({ written, skipped, rolledBack: false, error: null });

  log.info("Import committed", {
    source: LOG_SOURCE,
    feature: "commit",
    sessionId: session.id,
    organizationId: session.organizationId,
    definition: session.definitionName,
    created: result.created,
    updated: result.updated,
    skipped: result.skipped,
  });

  return { session: await storeResult(session, result, "committed"), result };
}

function buildResult(opts: {
  written: ReadonlyArray<{ row: PreparedRow; recordId: string }>;
  skipped: readonly PreparedRow[];
  rolledBack: boolean;
  error: string | null;
  rolledBackRows?: readonly PreparedRow[];
  failedRowNumber?: number | null;
}): ImportResult {
  let created = 0;
  let updated = 0;
  for (const entry of opts.written) {
    if (entry.row.action === "update") updated++;
    else created++;
  }

  const problems: ImportResultRow[] = opts.skipped.map((row) => ({
    rowNumber: row.rowNumber,
    outcome: "skipped",
    reason: skipReason(row),
    recordId: null,
  }));

  let failed = 0;
  for (const row of opts.rolledBackRows ?? []) {
    const isTheOne = row.rowNumber === opts.failedRowNumber;
    if (isTheOne) failed++;
    problems.push({
      rowNumber: row.rowNumber,
      outcome: isTheOne ? "failed" : "skipped",
      reason: isTheOne
        ? `Could not be saved: ${opts.error ?? "unknown error"}`
        : `Not imported: row ${opts.failedRowNumber} failed and the whole import was rolled back.`,
      recordId: null,
    });
  }

  problems.sort((a, b) => a.rowNumber - b.rowNumber);

  return {
    created,
    updated,
    skipped: problems.filter((p) => p.outcome === "skipped").length,
    failed,
    problemRows: problems.slice(0, MAX_LISTED_PROBLEM_ROWS),
    unlistedProblemRows: Math.max(0, problems.length - MAX_LISTED_PROBLEM_ROWS),
    rolledBack: opts.rolledBack,
    error: opts.error,
  };
}

async function storeResult(
  session: ImportSession,
  result: ImportResult,
  status: ImportSessionStatus,
): Promise<ImportSession> {
  const row = await db
    .updateTable("import_sessions")
    .set({
      status,
      // Object, not a string. See the JSONB note in createImportSession.
      result: result as unknown as Record<string, unknown>,
      committedAt: new Date(),
    })
    .where("id", "=", session.id)
    .where("organizationId", "=", session.organizationId)
    .returningAll()
    .executeTakeFirstOrThrow();

  return toImportSession(row);
}

// ── Internals ──────────────────────────────────────────────────────────────

/**
 * Re-read and re-parse the session's file, then prepare it.
 *
 * The grid is not cached between steps. Re-parsing costs milliseconds
 * and means the preview and the commit read the same bytes through the
 * same code, with no shared state that could go stale between two
 * requests served by two different pods.
 */
async function prepareForSession(session: ImportSession): Promise<PreparedImport> {
  const definition = getImportDefinition(session.definitionName);
  const { columns, rows } = await readSessionGrid(session);

  // A file whose header row moved between steps would silently re-index
  // every mapping. It cannot move (both the sheet and the header index
  // are stored), so a column-count change means the stored object was
  // replaced under us.
  if (columns.length !== session.columns.length) {
    throw new ConflictError(
      "The file behind this import has changed. Start the import again.",
    );
  }

  return await prepareImport({
    definition,
    organizationId: session.organizationId,
    columns,
    rows,
    mapping: session.mapping,
  });
}

async function readSessionGrid(
  session: ImportSession,
): Promise<{ columns: string[]; rows: string[][] }> {
  if (!session.uploadedFileId) {
    throw new BadRequestError(
      "The file for this import has been deleted. Upload it again to start over.",
    );
  }

  const file = await getUploadedFile({
    id: session.uploadedFileId,
    organizationId: session.organizationId,
  });

  const object = await getObject(file.storageKey);
  const parsed = parseSpreadsheet(object.body, {
    filename: file.filename,
    contentType: file.contentType,
    sheetName: session.sheetName ?? undefined,
    // Re-use the index that was detected (or chosen) at upload time, so
    // the mapping's column indexes still mean what they meant.
    headerRowIndex: session.headerRowIndex,
  });

  return { columns: parsed.columns, rows: parsed.rows };
}

function assertNotCommitted(session: ImportSession): void {
  if (session.status === "committed") {
    throw new ConflictError("This import has already been committed.");
  }
}

function toImportSession(row: ImportSessionRow): ImportSession {
  return {
    id: row.id,
    organizationId: row.organizationId,
    createdBy: row.createdBy ?? null,
    definitionName: row.definitionName,
    uploadedFileId: row.uploadedFileId ?? null,
    filename: row.filename,
    status: row.status,
    sheetName: row.sheetName ?? null,
    headerRowIndex: Number(row.headerRowIndex ?? 0),
    columns: parseJsonColumn<string[]>(row.columns, []),
    mapping: parseJsonColumn<ColumnMappingEntry[]>(row.mapping, []),
    rowCount: Number(row.rowCount ?? 0),
    result: row.result === null || row.result === undefined
      ? null
      : parseJsonColumn<ImportResult | null>(row.result, null),
    committedAt: row.committedAt ?? null,
    createdAt: row.createdAt,
  };
}

/**
 * Read a JSONB column.
 *
 * The driver hands most jsonb values back already parsed, but not every
 * path through it does, and a column read as a string where an array was
 * expected fails much later as "columns.length is undefined". Accepting
 * both shapes here costs one branch and removes that whole class of
 * report.
 */
function parseJsonColumn<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  if (typeof value !== "string") return value as T;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
