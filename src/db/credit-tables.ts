/**
 * Kysely types for the prepaid credit ledger (db/migrations/*_credit_ledger.sql).
 *
 * The base src/db/schema.ts does not declare these tables. Services widen the
 * shared client with them, which changes types only, never queries:
 *
 *   import { db as baseDb } from "@/db/client.ts";
 *   const db = baseDb.withTables<CreditTables>();
 */
import type { ColumnType, Generated, Selectable } from "kysely";
import type { Product } from "@/db/schema.ts";

/** One row per org: the atomic spend gate. BIGINT arrives as a string. */
export type CreditBalancesTable = {
  organizationId: string;
  balance: ColumnType<string | bigint, bigint | number, bigint | number>;
  updatedAt: ColumnType<Date, Date | undefined, Date | undefined>;
};

/** Append-only audit trail; external_ref makes webhook grants idempotent. */
export type CreditLedgerEntriesTable = {
  id: Generated<string>;
  organizationId: string;
  delta: ColumnType<string | bigint, bigint | number, never>;
  reason: string;
  externalRef: string | null;
  metadata: unknown;
  createdAt: ColumnType<Date, Date | undefined, never>;
};

export type CreditLedgerEntry = Selectable<CreditLedgerEntriesTable>;

export type CreditTables = {
  credit_balances: CreditBalancesTable;
  credit_ledger_entries: CreditLedgerEntriesTable;
};

/**
 * A product row with the credit ledger migration's products.grants_credits
 * column. listProducts() selects every column, so the value is present at
 * runtime; the base Product type just does not name it.
 */
export type CreditPackProduct = Product & { grantsCredits?: number | null };
