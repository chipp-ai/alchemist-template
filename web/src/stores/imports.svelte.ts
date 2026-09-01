/**
 * Imports store -- server-mirroring state for the spreadsheet wizard.
 *
 * Reads (what can be imported, past runs) go through `createQuery`; the
 * wizard's own step-by-step calls are plain awaited mutations, because
 * each one is a deliberate act with a button behind it, and a cached
 * copy of "the preview as of thirty seconds ago" would be actively wrong
 * to show somebody about to commit.
 *
 * There is no upload code here. Step one of the wizard is the same
 * `<UploadField>` every other upload in this app uses.
 */

import { createQuery, invalidateQueries, type Query } from "../lib/query.svelte";
import { api } from "../lib/api";

// -- Types (mirror the API payloads) --

export type ImportFieldKind = "text" | "email" | "date" | "enum" | "number" | "boolean";

export interface ImportFieldSummary {
  key: string;
  label: string;
  kind: ImportFieldKind;
  required: boolean;
  inputOnly: boolean;
  options: string[] | null;
  help: string | null;
  aliases: string[];
}

export interface ImportDefinitionSummary {
  name: string;
  label: string;
  description: string;
  capability: string;
  acceptTypes: string[];
  matchBy: string[][];
  hasSample: boolean;
  fields: ImportFieldSummary[];
  canRun: boolean;
}

export type MappingConfidence = "exact" | "alias" | "fuzzy" | "none";

export interface ColumnProposal {
  columnIndex: number;
  columnLabel: string;
  fieldKey: string | null;
  confidence: MappingConfidence;
  ambiguous: boolean;
  candidates: string[];
}

export interface ColumnMappingEntry {
  columnIndex: number;
  fieldKey: string | null;
  custom?: string | null;
}

export type ImportSessionStatus = "parsed" | "mapped" | "committed" | "failed";

export interface ImportResultRow {
  rowNumber: number;
  outcome: "created" | "updated" | "skipped" | "failed";
  reason: string | null;
  recordId: string | null;
}

export interface ImportResult {
  created: number;
  updated: number;
  skipped: number;
  failed: number;
  problemRows: ImportResultRow[];
  unlistedProblemRows: number;
  rolledBack: boolean;
  error: string | null;
}

export interface ImportSessionSummary {
  id: string;
  definitionName: string;
  filename: string;
  status: ImportSessionStatus;
  sheetName: string | null;
  headerRowIndex: number;
  columns: string[];
  mapping: ColumnMappingEntry[];
  rowCount: number;
  result: ImportResult | null;
  createdBy: string | null;
  committedAt: string | null;
  createdAt: string;
}

export interface CellError {
  field: string;
  label: string;
  message: string;
}

export type RowAction = "create" | "update" | "skip";

export interface ImportPreviewRow {
  rowNumber: number;
  action: RowAction;
  values: Record<string, string | number | boolean | null>;
  errors: CellError[];
  duplicateOfRow: number | null;
  reason: string | null;
}

export interface ImportPreviewCounts {
  total: number;
  create: number;
  update: number;
  invalid: number;
  duplicate: number;
}

export interface ImportPreview {
  sessionId: string;
  definitionName: string;
  columns: string[];
  mapping: ColumnMappingEntry[];
  counts: ImportPreviewCounts;
  rows: ImportPreviewRow[];
  problemRows: ImportPreviewRow[];
  unlistedProblemRows: number;
}

export interface StartedImport {
  session: ImportSessionSummary;
  proposal: ColumnProposal[];
}

interface DefinitionsResponse {
  data: ImportDefinitionSummary[];
}

interface SessionsResponse {
  data: ImportSessionSummary[];
}

// -- Queries --

/** What this app can import, and what this person may run. */
export function getImportDefinitionsQuery(): Query<DefinitionsResponse> {
  return createQuery<DefinitionsResponse>({
    key: "imports:definitions",
    fetcher: () => api.get<DefinitionsResponse>("/imports/definitions"),
    // Definitions change when the app is redeployed, not while somebody
    // is looking at the page.
    staleTime: 10 * 60_000,
  });
}

/** Past runs, newest first. */
export function getImportSessionsQuery(definition?: string): Query<SessionsResponse> {
  const suffix = definition ? `?definition=${encodeURIComponent(definition)}` : "";
  return createQuery<SessionsResponse>({
    key: `imports:sessions:${definition ?? "all"}`,
    fetcher: () => api.get<SessionsResponse>(`/imports/sessions${suffix}`),
    staleTime: 15_000,
  });
}

// -- Starting a session --

/**
 * Open a session on a file `<UploadField>` has already stored.
 *
 * The wizard does NOT post the bytes itself. Step one is the same picker
 * every other upload in this app uses, with its progress bar, its
 * allowlist and its stored row; this call hands the resulting file id to
 * the importer. That split is why the wizard has no upload code of its
 * own to keep in step with anything.
 */
export async function startImport(opts: {
  definition: string;
  uploadedFileId: string;
}): Promise<StartedImport> {
  const res = await api.post<{ data: StartedImport }>("/imports/sessions", {
    definition: opts.definition,
    uploadedFileId: opts.uploadedFileId,
  });
  invalidateQueries("imports:sessions");
  return res.data;
}

// -- Store facade --

export const importsStore = {
  getDefinitionsQuery: getImportDefinitionsQuery,
  getSessionsQuery: getImportSessionsQuery,
  start: startImport,

  async getDefinition(name: string): Promise<ImportDefinitionSummary> {
    const res = await api.get<{ data: ImportDefinitionSummary }>(
      `/imports/definitions/${encodeURIComponent(name)}`,
    );
    return res.data;
  },

  async saveMapping(
    sessionId: string,
    mapping: ColumnMappingEntry[],
  ): Promise<ImportSessionSummary> {
    const res = await api.patch<{ data: ImportSessionSummary }>(
      `/imports/sessions/${encodeURIComponent(sessionId)}/mapping`,
      { mapping },
    );
    return res.data;
  },

  async preview(sessionId: string): Promise<ImportPreview> {
    const res = await api.get<{ data: ImportPreview }>(
      `/imports/sessions/${encodeURIComponent(sessionId)}/preview`,
    );
    return res.data;
  },

  async commit(sessionId: string): Promise<{
    session: ImportSessionSummary;
    result: ImportResult;
  }> {
    const res = await api.post<{
      data: { session: ImportSessionSummary; result: ImportResult };
    }>(`/imports/sessions/${encodeURIComponent(sessionId)}/commit`);
    invalidateQueries("imports:sessions");
    return res.data;
  },

  sampleUrl(definition: string): string {
    return `/api/imports/definitions/${encodeURIComponent(definition)}/sample.csv`;
  },

  refresh(): void {
    invalidateQueries("imports:");
  },
};

// -- Formatting helpers shared by the import surfaces --

export const ROW_ACTION_LABELS: Record<RowAction, string> = {
  create: "New",
  update: "Update",
  skip: "Not imported",
};

export function rowActionBadgeClass(action: RowAction): string {
  if (action === "create") return "badge-good";
  // `badge-accent` is the kit's own class; good and bad are the shared
  // semantic ramps the other list surfaces define locally.
  if (action === "update") return "badge-accent";
  return "badge-bad";
}

export const CONFIDENCE_LABELS: Record<MappingConfidence, string> = {
  exact: "Exact",
  alias: "Known name",
  fuzzy: "Close match",
  none: "Not matched",
};

/** One value as the wizard shows it. Empty reads as a dash, never "null". */
export function displayValue(value: string | number | boolean | null): string {
  if (value === null || value === "") return "--";
  if (value === true) return "Yes";
  if (value === false) return "No";
  return String(value);
}
