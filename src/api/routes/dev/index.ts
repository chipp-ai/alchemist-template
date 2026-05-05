/**
 * Dev Routes — local-only auth shortcut + DB seeding for agent
 * verification flows.
 *
 * Mounted at /api/dev/*. The whole router 404s in production
 * (NODE_ENV === "production") so even an accidental misconfiguration
 * can't expose these endpoints to real traffic. The deployed customer
 * pod sets NODE_ENV=production via the rollout controller, so the
 * routes are dead in prod by default. Locally (and inside the agent's
 * sandbox running `deno task dev`), NODE_ENV is "development" and the
 * routes light up.
 *
 * These exist so the agent can verify auth-gated flows WITHOUT having
 * to drive the OTP send + email + verify cycle. SMTP isn't configured
 * in the sandbox — the OTP email is logged to console and never
 * delivered, which would force the agent to either screen-scrape the
 * console log or skip auth verification entirely. /api/dev/login is
 * the escape hatch.
 *
 * Endpoints:
 *   POST /api/dev/login    — instant login. Body: { email, name? }.
 *                            Looks up or creates user + org, sets the
 *                            same session cookie OTP-verify would set,
 *                            returns { user, organization }.
 *   POST /api/dev/seed     — populate the DB with canned scenarios or
 *                            ad-hoc rows. See SeedSchema below.
 *   POST /api/dev/reset    — hard-reset the DB to a clean state.
 *                            Truncates app.* + billing.* + jobs.*.
 *                            Use BEFORE seeding to guarantee a known
 *                            starting point.
 *
 * The dev module is the CANONICAL agent test-prep surface. Any new
 * domain table that needs seed support should grow a case here.
 */

import { Hono } from "hono";
import { setCookie } from "hono/cookie";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { sql } from "kysely";
import { db } from "@/db/client.ts";
import { createSessionToken } from "@/api/middleware/auth.ts";
import { log } from "@/lib/logger.ts";
import { BadRequestError, NotFoundError } from "@/utils/errors.ts";
import { validationHook } from "@/utils/zod-validation-hook.ts";

const SESSION_COOKIE = "session_id";
const IS_PROD = Deno.env.get("NODE_ENV") === "production";

const devRoutes = new Hono();

/**
 * Production guard. Mounted before every route. In production, the
 * router treats every path as not-found so the API surface is
 * indistinguishable from a stack that never registered the routes.
 */
devRoutes.use("*", async (c, next) => {
  if (IS_PROD) {
    throw new NotFoundError("Route not found");
  }
  await next();
});

// ── Helpers ──

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
}

async function findOrCreateUserWithOrg(
  email: string,
  name?: string,
): Promise<{
  user: { id: string; email: string; name: string | null; role: string; organizationId: string };
  organization: { id: string; name: string; slug: string | null; subscriptionTier: string };
}> {
  // Already exists?
  const existing = await db
    .selectFrom("users")
    .select(["id", "email", "name", "role", "organizationId"])
    .where("email", "=", email)
    .executeTakeFirst();

  if (existing && existing.organizationId) {
    const org = await db
      .selectFrom("organizations")
      .select(["id", "name", "slug", "subscriptionTier"])
      .where("id", "=", existing.organizationId)
      .executeTakeFirstOrThrow();
    return {
      user: { ...existing, organizationId: existing.organizationId },
      organization: org,
    };
  }

  // Fresh — create org + user atomically.
  const displayName = name ?? email.split("@")[0];
  const orgSlug = slugify(displayName) + "-" + Math.random().toString(36).slice(2, 8);

  return await db.transaction().execute(async (trx) => {
    const org = await trx
      .insertInto("organizations")
      .values({
        name: `${displayName}'s Organization`,
        slug: orgSlug,
        subscriptionTier: "FREE",
        creditsExhausted: false,
      })
      .returning(["id", "name", "slug", "subscriptionTier"])
      .executeTakeFirstOrThrow();

    const user = await trx
      .insertInto("users")
      .values({
        email,
        name: displayName,
        role: "owner",
        organizationId: org.id,
        emailVerified: true,
      })
      .returning(["id", "email", "name", "role", "organizationId"])
      .executeTakeFirstOrThrow();

    return {
      user: { ...user, organizationId: user.organizationId! },
      organization: org,
    };
  });
}

// ── POST /api/dev/login ──

const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  name: z.string().trim().min(1).max(120).optional(),
});

devRoutes.post(
  "/login",
  zValidator("json", loginSchema, validationHook),
  async (c) => {
    const { email, name } = c.req.valid("json");

    const { user, organization } = await findOrCreateUserWithOrg(email, name);

    const token = await createSessionToken({
      id: user.id,
      email: user.email,
      name: user.name,
      organizationId: user.organizationId,
      role: user.role,
    });

    setCookie(c, SESSION_COOKIE, token, {
      httpOnly: true,
      secure: false, // dev-only route — local HTTP is fine
      sameSite: "Lax",
      path: "/",
      maxAge: 7 * 24 * 60 * 60,
    });

    log.info("Dev login", {
      source: "dev",
      feature: "login",
      userId: user.id,
      email: user.email,
    });

    return c.json({
      user: { id: user.id, email: user.email, name: user.name },
      organization,
      session_cookie: SESSION_COOKIE,
    });
  },
);

// ── POST /api/dev/seed ──
//
// Two modes (use whichever maps to your test scenario):
//
// (a) `users` — bulk create users with their own orgs. Each entry
//     follows the same login shape. Returns an array of { user, organization }.
//
// (b) `raw` — ad-hoc inserts against any registered table.
//     Each entry is { table: "users", rows: [{...}] }. Rows pass
//     through Kysely .values() unchanged — caller is responsible for
//     column shapes. Tables are unqualified (single-schema customer
//     runtime; see db/migrations/001_initial_schema.sql).
//
// Both modes can be supplied in one call. Operations run inside a
// single transaction so a failure rolls back everything.

const seedSchema = z.object({
  users: z
    .array(
      z.object({
        email: z.string().trim().toLowerCase().email(),
        name: z.string().trim().min(1).max(120).optional(),
      }),
    )
    .optional(),
  raw: z
    .array(
      z.object({
        // Unqualified table name, e.g. "users", "token_usage".
        table: z
          .string()
          .regex(/^[a-z_][a-z0-9_]*$/i, "table must be a valid unqualified identifier"),
        rows: z.array(z.record(z.string(), z.unknown())).min(1).max(500),
      }),
    )
    .optional(),
});

devRoutes.post(
  "/seed",
  zValidator("json", seedSchema, validationHook),
  async (c) => {
    const body = c.req.valid("json");
    if (!body.users?.length && !body.raw?.length) {
      throw new BadRequestError("seed body must include `users` and/or `raw`");
    }

    const seeded = await db.transaction().execute(async (trx) => {
      const usersOut: Array<Record<string, unknown>> = [];
      if (body.users?.length) {
        for (const u of body.users) {
          // Reuse the same find-or-create path as /login so seeding is
          // idempotent across re-runs (handy when the agent reseeds
          // mid-flow without resetting first).
          const existing = await trx
            .selectFrom("users")
            .select(["id", "email", "name", "role", "organizationId"])
            .where("email", "=", u.email)
            .executeTakeFirst();
          if (existing && existing.organizationId) {
            const org = await trx
              .selectFrom("organizations")
              .select(["id", "name", "slug"])
              .where("id", "=", existing.organizationId)
              .executeTakeFirstOrThrow();
            usersOut.push({ user: existing, organization: org });
            continue;
          }
          const displayName = u.name ?? u.email.split("@")[0];
          const orgSlug = slugify(displayName) + "-" + Math.random().toString(36).slice(2, 8);
          const org = await trx
            .insertInto("organizations")
            .values({
              name: `${displayName}'s Organization`,
              slug: orgSlug,
              subscriptionTier: "FREE",
              creditsExhausted: false,
            })
            .returning(["id", "name", "slug"])
            .executeTakeFirstOrThrow();
          const user = await trx
            .insertInto("users")
            .values({
              email: u.email,
              name: displayName,
              role: "owner",
              organizationId: org.id,
              emailVerified: true,
            })
            .returning(["id", "email", "name", "role", "organizationId"])
            .executeTakeFirstOrThrow();
          usersOut.push({ user, organization: org });
        }
      }

      const rawOut: Array<{ table: string; inserted: number }> = [];
      if (body.raw?.length) {
        for (const entry of body.raw) {
          // deno-lint-ignore no-explicit-any
          const result = await trx.insertInto(entry.table as any).values(entry.rows as any).executeTakeFirst();
          rawOut.push({
            table: entry.table,
            inserted: Number(result.numInsertedOrUpdatedRows ?? 0),
          });
        }
      }

      return { users: usersOut, raw: rawOut };
    });

    log.info("Dev seed", {
      source: "dev",
      feature: "seed",
      userCount: seeded.users.length,
      rawTables: seeded.raw.length,
    });

    return c.json({ ok: true, seeded });
  },
);

// ── POST /api/dev/reset ──
//
// Truncates the schema. Two modes:
//   (a) Default — wipes users / organizations / otps / sessions / invites,
//       token_usage, job_history. Tables remain; only rows go.
//   (b) `tables: [...]` — caller-specified subset of TRUNCATE-able
//       tables. Same regex-validated unqualified table name shape as /seed.

const resetSchema = z.object({
  tables: z
    .array(
      z.string().regex(/^[a-z_][a-z0-9_]*$/i),
    )
    .optional(),
});

const DEFAULT_TRUNCATE_TABLES = [
  "token_usage",
  "job_history",
  "api_credentials",
  "invites",
  "sessions",
  "otps",
  "users",
  "organizations",
];

devRoutes.post(
  "/reset",
  zValidator("json", resetSchema, validationHook),
  async (c) => {
    const body = c.req.valid("json");
    const targets = body.tables?.length ? body.tables : DEFAULT_TRUNCATE_TABLES;

    // CASCADE so FK references go quietly. RESTART IDENTITY resets
    // any sequences (currently none — UUIDs everywhere — but harmless
    // and future-proof).
    const stmt = `TRUNCATE TABLE ${targets.join(", ")} RESTART IDENTITY CASCADE`;
    await sql.raw(stmt).execute(db);

    log.info("Dev reset", { source: "dev", feature: "reset", tables: targets });
    return c.json({ ok: true, truncated: targets });
  },
);

// ── GET /api/dev/info ──
//
// Health-check + capability advertisement so the agent can probe what
// dev affordances exist without trial-and-error.

devRoutes.get("/info", (c) => {
  return c.json({
    enabled: !IS_PROD,
    nodeEnv: Deno.env.get("NODE_ENV") ?? "development",
    endpoints: {
      "POST /api/dev/login": {
        body: { email: "string", name: "string?" },
        returns: "{ user, organization, session_cookie }",
        sets_cookie: SESSION_COOKIE,
      },
      "POST /api/dev/seed": {
        body: {
          users: "{ email, name? }[]?",
          raw: "{ table: 'app.X', rows: [{...}] }[]?",
        },
      },
      "POST /api/dev/reset": {
        body: { tables: "string[]?  // default = all app/billing/jobs tables" },
      },
    },
  });
});

export { devRoutes };
