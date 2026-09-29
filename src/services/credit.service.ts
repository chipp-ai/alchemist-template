/**
 * Prepaid credit ledger -- the metered lane for interactive MCP clients.
 *
 * The local ledger is AUTHORITATIVE for spend; Stripe is only the payment
 * rail that funds it (credit-pack / allowance products via the billing
 * webhook). This is the same architecture both Chipp and the Alchemist
 * platform run in production.
 *
 * Invariants (each is a production scar somewhere):
 *   - Grants are IDEMPOTENT: keyed on a UNIQUE external_ref
 *     (cs:{checkout_session_id} for packs, inv:{invoice_id} for
 *     subscription allowances). Stripe delivers webhooks at-least-once.
 *   - Debits are ATOMIC: one conditional UPDATE (balance >= cost). Never
 *     read-modify-write; never negative balances.
 *   - Every balance change appends a ledger entry (audit trail).
 *   - A debit whose tool run then FAILS is refunded (reason
 *     "tool_error_refund") -- charge -> run -> refund-on-failure.
 */

import { sql } from "kysely";
import { db as baseDb } from "@/db/client.ts";
import type { CreditTables } from "@/db/credit-tables.ts";
import { log } from "@/lib/logger.ts";
import { BadRequestError } from "@/utils/errors.ts";

const db = baseDb.withTables<CreditTables>();

export interface GrantResult {
  /** False when the external_ref was already granted (idempotent replay). */
  granted: boolean;
  balance: bigint;
}

export type DebitResult =
  | { ok: true; balance: bigint }
  | { ok: false; balance: bigint };

export const creditService = {
  /**
   * Grant credits to an org. When `externalRef` is provided the grant is
   * idempotent -- a replay with the same ref is a no-op.
   */
  async grant(params: {
    organizationId: string;
    amount: number;
    reason: string;
    externalRef?: string | null;
    metadata?: Record<string, unknown> | null;
  }): Promise<GrantResult> {
    if (!Number.isInteger(params.amount) || params.amount <= 0) {
      throw new BadRequestError("Credit grant amount must be a positive integer.");
    }

    return await db.transaction().execute(async (trx) => {
      const entry = await trx
        .insertInto("credit_ledger_entries")
        .values({
          organizationId: params.organizationId,
          delta: BigInt(params.amount),
          reason: params.reason,
          externalRef: params.externalRef ?? null,
          metadata: params.metadata ?? null,
        })
        .onConflict((oc) => oc.column("externalRef").doNothing())
        .returning(["id"])
        .executeTakeFirst();

      if (!entry) {
        // Same external_ref already granted -- webhook replay. No-op.
        const existing = await trx
          .selectFrom("credit_balances")
          .select("balance")
          .where("organizationId", "=", params.organizationId)
          .executeTakeFirst();
        return { granted: false, balance: BigInt(existing?.balance ?? 0) };
      }

      const updated = await trx
        .insertInto("credit_balances")
        .values({
          organizationId: params.organizationId,
          balance: BigInt(params.amount),
          updatedAt: new Date(),
        })
        .onConflict((oc) =>
          oc.column("organizationId").doUpdateSet({
            balance: sql`credit_balances.balance + ${BigInt(params.amount)}`,
            updatedAt: new Date(),
          })
        )
        .returning(["balance"])
        .executeTakeFirstOrThrow();

      log.info("Credits granted", {
        source: "credits",
        organizationId: params.organizationId,
        amount: params.amount,
        reason: params.reason,
        externalRef: params.externalRef ?? undefined,
      });

      return { granted: true, balance: BigInt(updated.balance) };
    });
  },

  /**
   * Atomically debit credits. Returns { ok: false } (with the current
   * balance) when the org cannot afford it -- never throws for
   * insufficiency, never goes negative.
   */
  async debit(params: {
    organizationId: string;
    amount: number;
    reason: string;
    metadata?: Record<string, unknown> | null;
  }): Promise<DebitResult> {
    if (!Number.isInteger(params.amount) || params.amount <= 0) {
      throw new BadRequestError("Credit debit amount must be a positive integer.");
    }

    return await db.transaction().execute(async (trx) => {
      // THE atomic spend gate: one conditional UPDATE. No read-modify-write.
      const updated = await trx
        .updateTable("credit_balances")
        .set({
          balance: sql`balance - ${BigInt(params.amount)}`,
          updatedAt: new Date(),
        })
        .where("organizationId", "=", params.organizationId)
        .where("balance", ">=", BigInt(params.amount))
        .returning(["balance"])
        .executeTakeFirst();

      if (!updated) {
        const existing = await trx
          .selectFrom("credit_balances")
          .select("balance")
          .where("organizationId", "=", params.organizationId)
          .executeTakeFirst();
        return { ok: false, balance: BigInt(existing?.balance ?? 0) };
      }

      await trx
        .insertInto("credit_ledger_entries")
        .values({
          organizationId: params.organizationId,
          delta: BigInt(-params.amount),
          reason: params.reason,
          metadata: params.metadata ?? null,
        })
        .execute();

      return { ok: true, balance: BigInt(updated.balance) };
    });
  },

  /** Refund a debit whose work then failed (charge -> run -> refund). */
  async refund(params: {
    organizationId: string;
    amount: number;
    reason: string;
    metadata?: Record<string, unknown> | null;
  }): Promise<void> {
    await this.grant({
      organizationId: params.organizationId,
      amount: params.amount,
      reason: params.reason,
      externalRef: null, // refunds are not idempotency-keyed
      metadata: params.metadata ?? null,
    });
  },

  async getBalance(organizationId: string): Promise<bigint> {
    const row = await db
      .selectFrom("credit_balances")
      .select("balance")
      .where("organizationId", "=", organizationId)
      .executeTakeFirst();
    return BigInt(row?.balance ?? 0);
  },

  async listEntries(organizationId: string, limit = 50) {
    return await db
      .selectFrom("credit_ledger_entries")
      .select(["id", "delta", "reason", "externalRef", "createdAt"])
      .where("organizationId", "=", organizationId)
      .orderBy("createdAt", "desc")
      .limit(limit)
      .execute();
  },
};
