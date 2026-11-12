/**
 * Generic, read-only access to this app's own tables for the MCP server
 * (src/mcp/tools/project_data.ts). Every project gets it out of the box, so
 * an assistant connected with the person's own login can learn the data
 * model and read rows without a project-specific tool.
 *
 * Safety model (fail closed):
 *
 * - HIDDEN tables never appear, in the model or in a query: auth, secret and
 *   infrastructure tables (users, sign-in codes, sessions, API keys, OAuth,
 *   invites, portal links, verification, member sync state, the event log,
 *   the job queue, the email outbox, search embeddings, migrations), plus any
 *   table whose NAME looks like one (token, secret, session, credential,
 *   oauth, otp, password, api_key, verification). A project hides its own
 *   table with `configureMcpDataTable(name, { hidden: true })`.
 * - HIDDEN columns never appear: any column whose name suggests a secret
 *   (secret, token, hash, password, passcode, otp, api_key, credential,
 *   private_key, salt, signature), and vector embeddings.
 * - A table is QUERYABLE only when it has an organization_id column. Every
 *   query is pinned to the caller's organization in its WHERE clause. A
 *   table without one is listed in the model, marked not queryable.
 * - Some tables need more than read access: billing tables need
 *   billing.manage, mailing-list tables need email.broadcast.
 *   `configureMcpDataTable(name, { capability })` sets it for a project
 *   table.
 * - The query is STRUCTURED (table, columns, simple filters, order, limit),
 *   never SQL text. Identifiers are checked against the introspected
 *   allowlist and quoted by the driver; values are bound parameters.
 * - It runs in a READ ONLY transaction with a 5 second statement timeout,
 *   and returns at most MAX_QUERY_ROWS rows.
 */

import { sql } from "@/db/client.ts";
import { can, type Capability } from "@/lib/roles.ts";
import { BadRequestError, ForbiddenError, NotFoundError } from "@/utils/errors.ts";

export const MAX_QUERY_ROWS = 200;
export const DEFAULT_QUERY_ROWS = 50;
const STATEMENT_TIMEOUT_MS = 5000;
const MAX_CELL_CHARS = 2000;
const ORG_COLUMN = "organization_id";

const HIDDEN_TABLES = new Set([
  "users",
  "otps",
  "sessions",
  "api_credentials",
  "invites",
  "portal_access_tokens",
  "verification_sessions",
  "platform_member_sync_state",
  "platform_handoff_claims",
  "schema_migrations",
  "events",
  "event_subscriptions",
  "event_deliveries",
  "event_handler_receipts",
  "email_outbox",
  "scheduled_jobs",
  "job_history",
  "doc_search_index",
  "import_sessions",
]);

const HIDDEN_TABLE_PATTERN =
  /(^mcp_oauth|token|secret|session|credential|oauth|otp|password|api_?key|verification)/i;

export const HIDDEN_COLUMN_PATTERN =
  /(secret|token|hash|password|passcode|otp|api_?key|credential|private_?key|salt|signature)/i;

const TABLE_CAPABILITY: Record<string, Capability> = {
  credit_balances: "billing.manage",
  credit_ledger_entries: "billing.manage",
  purchases: "billing.manage",
  chipp_donations: "billing.manage",
  email_contacts: "email.broadcast",
  email_campaigns: "email.broadcast",
  email_campaign_recipients: "email.broadcast",
  email_suppressions: "email.broadcast",
};

const overrides = new Map<string, { hidden?: boolean; capability?: Capability }>();

/**
 * Project hook: hide one of the project's tables from the MCP data tools,
 * or require a capability above `app.read` to see and query it. Call it at
 * module load (for example next to the table's service).
 */
export function configureMcpDataTable(
  table: string,
  opts: { hidden?: boolean; capability?: Capability },
): void {
  overrides.set(table, { ...overrides.get(table), ...opts });
}

export function isHiddenTable(table: string): boolean {
  const o = overrides.get(table);
  if (o?.hidden !== undefined) return o.hidden;
  return HIDDEN_TABLES.has(table) || HIDDEN_TABLE_PATTERN.test(table);
}

export function tableCapability(table: string): Capability {
  return overrides.get(table)?.capability ?? TABLE_CAPABILITY[table] ?? "app.read";
}

export interface ColumnInfo {
  name: string;
  type: string;
  nullable: boolean;
}

export interface TableInfo {
  table: string;
  columns: ColumnInfo[];
  primaryKey: string[];
  references: Array<{ column: string; refTable: string; refColumn: string; refHidden: boolean }>;
  queryable: boolean;
  note?: string;
}

interface RawColumn {
  table_name: string;
  column_name: string;
  data_type: string;
  udt_name: string;
  is_nullable: string;
}

function columnHidden(c: Pick<RawColumn, "column_name" | "udt_name">): boolean {
  return HIDDEN_COLUMN_PATTERN.test(c.column_name) || c.udt_name === "vector";
}

/** Run `fn` in a READ ONLY transaction with a statement timeout. */
async function readOnly<T>(fn: (tx: typeof sql) => Promise<T>): Promise<T> {
  return await sql.begin("read only", async (tx) => {
    await tx.unsafe(`SET LOCAL statement_timeout = ${STATEMENT_TIMEOUT_MS}`);
    return await fn(tx as unknown as typeof sql);
  }) as T;
}

/**
 * The data model this caller may see: tables, columns, types, keys and
 * relations, with hidden tables and columns left out.
 */
export async function describeDataModel(role: string): Promise<TableInfo[]> {
  return await readOnly(async (tx) => {
    const columns = await tx<RawColumn[]>`
      SELECT c.table_name, c.column_name, c.data_type, c.udt_name, c.is_nullable
      FROM information_schema.columns c
      JOIN information_schema.tables t
        ON t.table_schema = c.table_schema AND t.table_name = c.table_name
      WHERE c.table_schema = current_schema() AND t.table_type = 'BASE TABLE'
      ORDER BY c.table_name, c.ordinal_position`;
    const keys = await tx<
      {
        table_name: string;
        column_name: string;
        kind: string;
        ref_table: string | null;
        ref_column: string | null;
      }[]
    >`
      SELECT tc.table_name, kcu.column_name, tc.constraint_type AS kind,
             ccu.table_name AS ref_table, ccu.column_name AS ref_column
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON kcu.constraint_schema = tc.constraint_schema AND kcu.constraint_name = tc.constraint_name
      LEFT JOIN information_schema.constraint_column_usage ccu
        ON tc.constraint_type = 'FOREIGN KEY'
       AND ccu.constraint_schema = tc.constraint_schema AND ccu.constraint_name = tc.constraint_name
      WHERE tc.table_schema = current_schema()
        AND tc.constraint_type IN ('PRIMARY KEY', 'FOREIGN KEY')`;

    const byTable = new Map<string, TableInfo>();
    for (const c of columns) {
      if (isHiddenTable(c.table_name) || !can(role, tableCapability(c.table_name))) continue;
      let t = byTable.get(c.table_name);
      if (!t) {
        t = { table: c.table_name, columns: [], primaryKey: [], references: [], queryable: false };
        byTable.set(c.table_name, t);
      }
      if (c.column_name === ORG_COLUMN) t.queryable = true;
      if (columnHidden(c)) continue;
      t.columns.push({
        name: c.column_name,
        type: c.data_type === "USER-DEFINED" ? c.udt_name : c.data_type,
        nullable: c.is_nullable === "YES",
      });
    }
    for (const k of keys) {
      const t = byTable.get(k.table_name);
      if (!t || HIDDEN_COLUMN_PATTERN.test(k.column_name)) continue;
      if (k.kind === "PRIMARY KEY") {
        if (!t.primaryKey.includes(k.column_name)) t.primaryKey.push(k.column_name);
      } else if (k.ref_table && k.ref_column) {
        t.references.push({
          column: k.column_name,
          refTable: k.ref_table,
          refColumn: k.ref_column,
          refHidden: isHiddenTable(k.ref_table),
        });
      }
    }
    for (const t of byTable.values()) {
      if (!t.queryable) t.note = "Not queryable: the table has no organization_id column.";
    }
    return [...byTable.values()];
  });
}

export const FILTER_OPS = [
  "eq",
  "neq",
  "lt",
  "lte",
  "gt",
  "gte",
  "like",
  "ilike",
  "in",
  "is_null",
  "not_null",
] as const;
export type FilterOp = typeof FILTER_OPS[number];

export interface StructuredQuery {
  table: string;
  columns?: string[];
  filters?: Array<{ column: string; op: FilterOp; value?: unknown }>;
  orderBy?: { column: string; direction?: "asc" | "desc" };
  limit?: number;
  offset?: number;
}

export interface QueryResult {
  table: string;
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  limit: number;
  offset: number;
  truncated: boolean;
}

function scalar(v: unknown): unknown {
  if (v === null || typeof v === "number" || typeof v === "boolean") return v;
  if (typeof v === "string") return v;
  throw new BadRequestError("Filter values must be strings, numbers, booleans or null.");
}

function cell(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  if (v instanceof Uint8Array) return `[binary, ${v.byteLength} bytes]`;
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "string" && v.length > MAX_CELL_CHARS) {
    return `${v.slice(0, MAX_CELL_CHARS)}... [truncated]`;
  }
  if (typeof v === "object") {
    const text = JSON.stringify(v);
    return text.length > MAX_CELL_CHARS ? `${text.slice(0, MAX_CELL_CHARS)}... [truncated]` : v;
  }
  return v;
}

/**
 * Read rows from one of the app's tables, pinned to the caller's
 * organization. Unknown, hidden and forbidden tables are all "not found",
 * so a caller cannot probe for them.
 */
export async function queryTable(
  q: StructuredQuery,
  caller: { organizationId: string; role: string },
): Promise<QueryResult> {
  const table = q.table;
  if (isHiddenTable(table)) throw new NotFoundError("Table");
  if (!can(caller.role, tableCapability(table))) throw new NotFoundError("Table");

  const limit = Math.min(Math.max(Math.trunc(q.limit ?? DEFAULT_QUERY_ROWS), 1), MAX_QUERY_ROWS);
  const offset = Math.min(Math.max(Math.trunc(q.offset ?? 0), 0), 100_000);

  return await readOnly(async (tx) => {
    const cols = await tx<RawColumn[]>`
      SELECT c.table_name, c.column_name, c.data_type, c.udt_name, c.is_nullable
      FROM information_schema.columns c
      JOIN information_schema.tables t
        ON t.table_schema = c.table_schema AND t.table_name = c.table_name
      WHERE c.table_schema = current_schema() AND t.table_type = 'BASE TABLE'
        AND c.table_name = ${table}
      ORDER BY c.ordinal_position`;
    if (cols.length === 0) throw new NotFoundError("Table");
    if (!cols.some((c) => c.column_name === ORG_COLUMN)) {
      throw new ForbiddenError(
        `"${table}" has no organization_id column, so it cannot be queried here.`,
      );
    }
    const visible = cols.filter((c) => !columnHidden(c)).map((c) => c.column_name);
    const allowed = new Set(visible);
    const need = (column: string): string => {
      if (!allowed.has(column)) {
        throw new BadRequestError(`Unknown column "${column}" on "${table}".`);
      }
      return column;
    };

    const selected = q.columns && q.columns.length > 0 ? q.columns.map(need) : visible;

    // The org pin is always the first condition and cannot be removed.
    let where = tx`${tx(ORG_COLUMN)} = ${caller.organizationId}`;
    for (const f of q.filters ?? []) {
      const col = tx(need(f.column));
      let cond;
      switch (f.op) {
        case "eq":
          cond = tx`${col} = ${scalar(f.value) as string}`;
          break;
        case "neq":
          cond = tx`${col} <> ${scalar(f.value) as string}`;
          break;
        case "lt":
          cond = tx`${col} < ${scalar(f.value) as string}`;
          break;
        case "lte":
          cond = tx`${col} <= ${scalar(f.value) as string}`;
          break;
        case "gt":
          cond = tx`${col} > ${scalar(f.value) as string}`;
          break;
        case "gte":
          cond = tx`${col} >= ${scalar(f.value) as string}`;
          break;
        case "like":
          cond = tx`${col}::text LIKE ${String(scalar(f.value))}`;
          break;
        case "ilike":
          cond = tx`${col}::text ILIKE ${String(scalar(f.value))}`;
          break;
        case "in": {
          if (!Array.isArray(f.value) || f.value.length === 0 || f.value.length > 100) {
            throw new BadRequestError(`"in" needs an array of 1 to 100 values.`);
          }
          const values = f.value.map((v) => String(scalar(v)));
          cond = tx`${col}::text = ANY(${values})`;
          break;
        }
        case "is_null":
          cond = tx`${col} IS NULL`;
          break;
        case "not_null":
          cond = tx`${col} IS NOT NULL`;
          break;
        default:
          throw new BadRequestError(`Unknown filter operator.`);
      }
      where = tx`${where} AND ${cond}`;
    }

    const order = q.orderBy
      ? tx`ORDER BY ${tx(need(q.orderBy.column))} ${
        q.orderBy.direction === "desc" ? tx`DESC` : tx`ASC`
      }`
      : tx``;

    // One extra row tells us whether the page was cut.
    const rows = await tx<Record<string, unknown>[]>`
      SELECT ${tx(selected)} FROM ${tx(table)} WHERE ${where} ${order}
      LIMIT ${limit + 1} OFFSET ${offset}`;

    const truncated = rows.length > limit;
    const page = rows.slice(0, limit).map((r) => {
      const out: Record<string, unknown> = {};
      for (const c of selected) out[c] = cell(r[c]);
      return out;
    });
    return {
      table,
      columns: selected,
      rows: page,
      rowCount: page.length,
      limit,
      offset,
      truncated,
    };
  });
}
