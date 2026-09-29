/**
 * API keys -- the programmatic auth method for this API product.
 *
 * Keys look like `api_sk_<43 base64url chars>`; the plaintext is shown ONCE
 * at mint. Storage is SHA-256 hex (keyHash) plus a short keyPrefix for an
 * indexed lookup before the constant-time hash compare. Backed by the
 * api_credentials table that ships in 001_initial_schema.sql.
 *
 * Keys are user-scoped; the org is resolved live from `users` at verify so
 * it never goes stale. Mint/list/revoke via /api/api-keys (session auth);
 * callers send `Authorization: Bearer api_sk_...` (see
 * src/api/middleware/api-key-auth.ts).
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { Buffer } from "node:buffer";
import { db } from "@/db/client.ts";
import { log } from "@/lib/logger.ts";

export const API_KEY_PREFIX = "api_sk_";

/** Indexed-lookup prefix length (column is varchar(20)). */
const KEY_PREFIX_LENGTH = 15;

function generateApiKey(): string {
  return `${API_KEY_PREFIX}${randomBytes(32).toString("base64url")}`;
}

function hashKey(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

export interface MintedApiKey {
  id: string;
  /** The full plaintext key. Shown once; never retrievable again. */
  key: string;
  keyPrefix: string;
  name: string;
}

export interface ResolvedApiKey {
  keyId: string;
  userId: string;
  organizationId: string | null;
  email: string;
  name: string | null;
  role: string;
}

export const apiKeyService = {
  /** Mint a new key for a user. Returns the plaintext exactly once. */
  async mint(params: { userId: string; name: string }): Promise<MintedApiKey> {
    const raw = generateApiKey();
    const keyPrefix = raw.slice(0, KEY_PREFIX_LENGTH);

    const row = await db
      .insertInto("api_credentials")
      .values({
        userId: params.userId,
        name: params.name,
        keyHash: hashKey(raw),
        keyPrefix,
        scopes: ["*"],
      })
      .returning(["id"])
      .executeTakeFirstOrThrow();

    log.info("API key minted", {
      source: "api-keys",
      userId: params.userId,
      keyPrefix,
    });

    return { id: row.id, key: raw, keyPrefix, name: params.name };
  },

  /**
   * Resolve a presented raw key to its owner, or null. Prefix-indexed
   * lookup, then a constant-time hash comparison.
   */
  async verify(rawKey: string): Promise<ResolvedApiKey | null> {
    if (!rawKey.startsWith(API_KEY_PREFIX)) return null;
    const keyPrefix = rawKey.slice(0, KEY_PREFIX_LENGTH);
    const presentedHash = hashKey(rawKey);

    const candidates = await db
      .selectFrom("api_credentials as k")
      .innerJoin("users as u", "u.id", "k.userId")
      .where("k.keyPrefix", "=", keyPrefix)
      .where("k.isActive", "=", true)
      .select([
        "k.id as keyId",
        "k.keyHash as keyHash",
        "u.id as userId",
        "u.organizationId as organizationId",
        "u.email as email",
        "u.name as name",
        "u.role as role",
      ])
      .execute();

    for (const row of candidates) {
      const a = Buffer.from(presentedHash, "hex");
      const b = Buffer.from(row.keyHash, "hex");
      if (a.length === b.length && timingSafeEqual(a, b)) {
        // Best-effort last-used stamp; never blocks the request.
        db.updateTable("api_credentials")
          .set({ lastUsedAt: new Date() })
          .where("id", "=", row.keyId)
          .execute()
          .catch((e) => {
            log.warn("API key last-used stamp failed", {
              source: "api-keys",
              keyId: row.keyId,
            }, e instanceof Error ? e : new Error(String(e)));
          });

        return {
          keyId: row.keyId,
          userId: row.userId,
          organizationId: row.organizationId,
          email: row.email,
          name: row.name,
          role: row.role,
        };
      }
    }
    return null;
  },

  /** List a user's keys (prefix + metadata only -- never the hash). */
  async listForUser(userId: string) {
    return await db
      .selectFrom("api_credentials")
      .select(["id", "name", "keyPrefix", "isActive", "lastUsedAt", "createdAt"])
      .where("userId", "=", userId)
      // Both key kinds share api_credentials: list only this kind's keys.
      .where((eb) => eb(eb.fn("left", [eb.ref("keyPrefix"), eb.lit(API_KEY_PREFIX.length)]), "=", API_KEY_PREFIX))
      .orderBy("createdAt", "desc")
      .execute();
  },

  /** Revoke (deactivate) a key. Scoped to the owning user. Idempotent. */
  async revoke(keyId: string, userId: string): Promise<void> {
    await db
      .updateTable("api_credentials")
      .set({ isActive: false })
      .where("id", "=", keyId)
      .where("userId", "=", userId)
      .where((eb) => eb(eb.fn("left", [eb.ref("keyPrefix"), eb.lit(API_KEY_PREFIX.length)]), "=", API_KEY_PREFIX))
      .execute();
  },
};
