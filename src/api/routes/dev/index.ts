/**
 * Dev Routes — local-only auth shortcut + DB seeding for agent
 * verification flows.
 *
 * Mounted at /api/dev/*. The whole router 404s UNLESS the dev surface
 * is explicitly enabled via ALCHEMIST_DEV_ROUTES (see lib/dev-mode.ts).
 * This is FAIL CLOSED: the routes are dead by default and only light up
 * when something deliberately opts in. The previous gate keyed off
 * `NODE_ENV !== "production"`, which was fail-OPEN — a deployed pod
 * missing NODE_ENV=production leaked instant-login + DB reset to the
 * public internet. Local dev and the agent sandbox set
 * ALCHEMIST_DEV_ROUTES=1 via `deno task dev`, so the routes light up
 * there; nothing in the customer deploy path sets it.
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
import { deleteCookie, setCookie } from "hono/cookie";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { sql } from "kysely";
import { db } from "@/db/client.ts";
import { createSessionToken } from "@/api/middleware/auth.ts";
import { log } from "@/lib/logger.ts";
import { BadRequestError, NotFoundError } from "@/utils/errors.ts";
import { validationHook } from "@/utils/zod-validation-hook.ts";
import { devRoutesEnabled } from "@/lib/dev-mode.ts";

const SESSION_COOKIE = "session_id";

const devRoutes = new Hono();

/**
 * Fail-closed guard. Mounted before every route. Unless the dev surface
 * is explicitly enabled (ALCHEMIST_DEV_ROUTES truthy), the router treats
 * every path as not-found so the API surface is indistinguishable from a
 * stack that never registered the routes. Evaluated per-request (not
 * cached at import) so the gate can't be defeated by import ordering.
 */
devRoutes.use("*", async (c, next) => {
  if (!devRoutesEnabled()) {
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

// ── GET /api/dev/login ──
//
// Browser-clickable variant of POST /api/dev/login. Used by the
// desktop app's "Open in real Chrome" affordance: the operator
// clicks a magic-link URL that includes an email + redirect path,
// the template mints the session cookie, redirects to the redirect
// path. The operator lands on the authenticated page in their own
// browser, no manual login form, no copy-paste of cookies.
//
// Like every dev route, this 404s in production.

const loginGetSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  redirect: z.string().optional(),
});

devRoutes.get(
  "/login",
  zValidator("query", loginGetSchema, validationHook),
  async (c) => {
    const { email, redirect } = c.req.valid("query");
    const { user } = await findOrCreateUserWithOrg(email, undefined);

    const token = await createSessionToken({
      id: user.id,
      email: user.email,
      name: user.name,
      organizationId: user.organizationId,
      role: user.role,
    });

    setCookie(c, SESSION_COOKIE, token, {
      httpOnly: true,
      secure: false,
      sameSite: "Lax",
      path: "/",
      maxAge: 7 * 24 * 60 * 60,
    });

    log.info("Dev login (GET)", {
      source: "dev",
      feature: "login-get",
      userId: user.id,
      email: user.email,
    });

    // Redirect to the requested path (if relative — never to an
    // absolute URL, which would let the link become an open
    // redirector). Default to the SPA root if no redirect given.
    const target = redirect && redirect.startsWith("/") ? redirect : "/";
    return c.redirect(target);
  },
);

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

/**
 * GET /api/dev/logout
 * POST /api/dev/logout
 *
 * Clears the session cookie set by /api/dev/login (or any other auth
 * path — it's the same cookie name). Mirrors /api/auth/logout but
 * lives under /api/dev so agent verification scripts can use a single
 * dev-namespace for the whole login/logout flow without crossing into
 * the production auth routes. Both verbs are accepted: GET for
 * easy browser-bar testing, POST for the canonical form-submit /
 * API-call shape. Idempotent — logging out twice is a no-op.
 */
devRoutes.get("/logout", (c) => {
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
  return c.json({ ok: true });
});
devRoutes.post("/logout", (c) => {
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
  return c.json({ ok: true });
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

// ── POST /api/dev/snapshot ──
//
// Capture the current row contents of the default-truncate tables
// (organizations, users, otps, sessions, invites, etc.) to a JSON
// file at /tmp/alchemist-snapshots/<tag>.json. Caller supplies a tag
// to identify the snapshot; if no tag is given, an auto-tag based on
// the wall-clock is generated.
//
// Intended use: agent (or the desktop operator) snapshots before
// running a verification flow, makes changes, then /restore if
// anything broke. Pairs with /reset for "I want to start fresh".
//
// Storage:
//   - /tmp is process-local and ephemeral (lost on container restart).
//     Acceptable for dev where the customer template is running
//     locally; for the agent's E2B sandbox the snapshot lives for the
//     duration of the run, which is the only relevant window.
//   - File format: JSON object keyed by table name, value is the row
//     array as returned by SELECT *. Preserves all columns.

const SNAPSHOT_DIR = "/tmp/alchemist-snapshots";

const snapshotSchema = z.object({
  tag: z
    .string()
    .regex(/^[a-zA-Z0-9._-]{1,64}$/, "tag must be 1-64 chars of [A-Za-z0-9._-]")
    .optional(),
});

const restoreSchema = z.object({
  tag: z.string().regex(/^[a-zA-Z0-9._-]{1,64}$/),
});

/// Discover every base table in the `public` schema + topo-sort by
/// foreign-key dependency so a snapshot can capture the full DB state
/// (including customer-domain tables like `recipes`, `posts`, etc.,
/// not just the auth/billing tables a hardcoded list would cover).
/// Parents come first in the returned order — restore-time INSERT
/// can run sequentially without FK errors.
///
/// Skips Kysely's `kysely_migration` + `kysely_migration_lock` so the
/// snapshot isn't tied to a particular migration version (would
/// otherwise prevent restoring across a schema migration).
async function discoverSnapshotTables(): Promise<string[]> {
  // List base tables in public schema, excluding migration metadata.
  const tablesResult = await sql<{ table_name: string }>`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_type = 'BASE TABLE'
      AND table_name NOT LIKE 'kysely_migration%'
    ORDER BY table_name
  `.execute(db);
  const allTables = tablesResult.rows.map((r) => r.table_name);
  const tableSet = new Set(allTables);

  // List FK edges (child → parent). information_schema's
  // referential_constraints + key_column_usage are the standard SQL
  // way to enumerate FKs; pg's constraint_column_usage works too but
  // is implementation-specific.
  const edges = await sql<{ child: string; parent: string }>`
    SELECT
      tc.table_name AS child,
      ccu.table_name AS parent
    FROM information_schema.table_constraints AS tc
    JOIN information_schema.constraint_column_usage AS ccu
      ON tc.constraint_name = ccu.constraint_name
     AND tc.table_schema = ccu.table_schema
    WHERE tc.constraint_type = 'FOREIGN KEY'
      AND tc.table_schema = 'public'
      AND tc.table_name <> ccu.table_name
  `.execute(db);

  // Kahn's algorithm — topo-sort by in-degree. Parents come out
  // before children. Cycles (legal in pg if the FK is DEFERRABLE)
  // get appended at the end in arbitrary order; restore handles
  // them via the existing TRUNCATE…CASCADE + INSERT sequence.
  const children: Record<string, Set<string>> = {};
  const parents: Record<string, Set<string>> = {};
  for (const t of allTables) {
    children[t] = new Set();
    parents[t] = new Set();
  }
  for (const e of edges.rows) {
    if (!tableSet.has(e.child) || !tableSet.has(e.parent)) continue;
    children[e.parent].add(e.child);
    parents[e.child].add(e.parent);
  }
  const order: string[] = [];
  const ready = allTables.filter((t) => parents[t].size === 0).sort();
  while (ready.length) {
    const t = ready.shift()!;
    order.push(t);
    for (const c of children[t]) {
      parents[c].delete(t);
      if (parents[c].size === 0) {
        // Insert sorted so the output is deterministic across runs.
        const idx = ready.findIndex((r) => r > c);
        if (idx === -1) ready.push(c);
        else ready.splice(idx, 0, c);
      }
    }
  }
  // Append any remaining (cycles). Sorted for determinism.
  for (const t of allTables) {
    if (!order.includes(t)) order.push(t);
  }
  return order;
}

function autoTag(): string {
  // Compact ISO timestamp: 20260521T150459Z
  const iso = new Date().toISOString();
  return iso.replace(/[-:]/g, "").replace(/\..*$/, "Z").replace("T", "T");
}

devRoutes.post(
  "/snapshot",
  zValidator("json", snapshotSchema, validationHook),
  async (c) => {
    const body = c.req.valid("json");
    const tag = body.tag ?? autoTag();
    await Deno.mkdir(SNAPSHOT_DIR, { recursive: true });

    const tables = await discoverSnapshotTables();
    const dump: Record<string, unknown[]> = {};
    const tableCounts: Record<string, number> = {};
    for (const table of tables) {
      // SELECT * captures the row state as-is — columns include any
      // serial PKs, timestamps, JSON columns, etc. Kysely stringifies
      // JSON columns on write so JSON.stringify here round-trips
      // cleanly.
      const result = await sql<Record<string, unknown>>`
        SELECT * FROM ${sql.raw(table)}
      `.execute(db);
      dump[table] = result.rows;
      tableCounts[table] = result.rows.length;
    }

    const path = `${SNAPSHOT_DIR}/${tag}.json`;
    await Deno.writeTextFile(path, JSON.stringify({ tag, ts: new Date().toISOString(), dump }, null, 0));

    log.info("Dev snapshot", {
      source: "dev",
      feature: "snapshot",
      tag,
      path,
      tableCounts,
    });
    return c.json({ ok: true, tag, path, table_counts: tableCounts });
  },
);

// ── POST /api/dev/restore ──
//
// Truncate the snapshot tables (CASCADE so FKs go quietly) and
// re-insert each row from the named snapshot file in dependency
// order. The result is a DB whose row state matches the snapshot
// moment exactly — modulo any schema changes between snapshot and
// restore (which we don't try to handle; SCHEMA migrations should
// be applied separately).

devRoutes.post(
  "/restore",
  zValidator("json", restoreSchema, validationHook),
  async (c) => {
    const { tag } = c.req.valid("json");
    const path = `${SNAPSHOT_DIR}/${tag}.json`;

    let payload: { tag: string; ts: string; dump: Record<string, unknown[]> };
    try {
      const text = await Deno.readTextFile(path);
      payload = JSON.parse(text);
    } catch (err) {
      throw new NotFoundError(`Snapshot not found: ${tag} (looked at ${path})`);
    }

    // Re-discover the current dep order at restore time rather than
    // trusting the snapshot's implicit order. Customer schemas evolve
    // between snapshot and restore — a new FK added in the interim
    // changes the safe insertion order. Re-discovery is cheap (one
    // SQL round trip) and keeps restore correct across schema drift
    // shorter than full-table changes.
    const tables = await discoverSnapshotTables();
    await db.transaction().execute(async (trx) => {
      // TRUNCATE in REVERSE dep order with CASCADE so FK references
      // go quietly. CASCADE handles any leaf tables we didn't
      // enumerate (e.g. a customer-domain table created after the
      // snapshot).
      const truncateOrder = [...tables].reverse();
      const truncateList = truncateOrder.filter((t) => t in payload.dump).join(", ");
      if (truncateList) {
        await sql.raw(`TRUNCATE TABLE ${truncateList} RESTART IDENTITY CASCADE`).execute(trx);
      }

      // INSERT in dep order. Each table's rows are inserted as a
      // batch via Kysely's .values(rows[]). Tables present in the
      // snapshot but absent from the current schema are silently
      // skipped — they were dropped between snapshot + restore.
      for (const table of tables) {
        const rows = payload.dump[table];
        if (!rows || rows.length === 0) continue;
        await trx
          .insertInto(table as never)
          .values(rows as never)
          .execute();
      }
    });

    log.info("Dev restore", {
      source: "dev",
      feature: "restore",
      tag,
      path,
    });
    return c.json({ ok: true, tag, ts: payload.ts });
  },
);

// ── GET /api/dev/snapshots ── list available snapshots
devRoutes.get("/snapshots", async (c) => {
  await Deno.mkdir(SNAPSHOT_DIR, { recursive: true });
  const entries: Array<{ tag: string; ts: string; size_bytes: number }> = [];
  for await (const dirent of Deno.readDir(SNAPSHOT_DIR)) {
    if (!dirent.isFile || !dirent.name.endsWith(".json")) continue;
    const tag = dirent.name.replace(/\.json$/, "");
    const stat = await Deno.stat(`${SNAPSHOT_DIR}/${dirent.name}`).catch(() => null);
    if (!stat) continue;
    entries.push({
      tag,
      ts: stat.mtime?.toISOString() ?? "",
      size_bytes: stat.size,
    });
  }
  // Newest first (mtime descending).
  entries.sort((a, b) => (b.ts > a.ts ? 1 : -1));
  return c.json({ snapshots: entries });
});

// ── GET /api/dev/info ──
//
// Health-check + capability advertisement so the agent can probe what
// dev affordances exist without trial-and-error.

devRoutes.get("/info", (c) => {
  return c.json({
    enabled: devRoutesEnabled(),
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
      "POST /api/dev/app-state": {
        purpose:
          "SPA push endpoint. The dev-panel client (web/src/lib/devpanel/) " +
          "POSTs the current store snapshot here on every change + 5s heartbeat.",
        body: { snapshot: "ClientSnapshot", markdown: "string" },
      },
      "GET /api/dev/app-state": {
        purpose:
          "Read the most recent client snapshot, merged with server-side " +
          "context (recent requests, recent errors, env). The agent's L1 " +
          "verification layer hits this BEFORE driving the browser.",
        returns:
          "{ client: ClientSnapshot, server: ServerSnapshot, markdown: string }",
      },
    },
  });
});

// ── /app-state — the dev panel's central exchange ──────────────────────────
//
// The SPA pushes its current state to POST /app-state on every store
// change (+ 5s heartbeat). The agent + the in-browser DevPanel read
// the merged client + server picture from GET /app-state.
//
// The endpoint is the contract the alchemist verification + implement
// agents lean on: "before driving the browser, curl this and read what
// the running app actually believes."
//
// Server-side context the GET response merges in:
//   - Recent HTTP requests (method, path, status, duration) from the
//     recent-activity middleware ring buffer.
//   - Recent errors (message, stack, source) — both request-thrown and
//     manually recorded.
//   - Env summary: NODE_ENV, hostname, runtime version.
//
// Client snapshots are kept in-memory only (not persisted to disk like
// chipp-deno's .scratch/app-state.md), because the alchemist customer
// pod is ephemeral and the agent reads via curl in the same dev
// session anyway.

import {
  getRecentRequests,
  getRecentErrors,
  type DevRequestRecord,
  type DevErrorRecord,
} from "@/lib/dev-activity.ts";

interface ClientSnapshotShape {
  timestamp: string;
  route: { hash: string; path: string; params: Record<string, string> };
  viewport: { width: number; height: number };
  stores: Record<string, unknown>;
  recentErrors: Array<{
    timestamp: string;
    message: string;
    stack?: string;
    source?: string;
  }>;
  storeOrder: string[];
}

let lastClientSnapshot: ClientSnapshotShape | null = null;
let lastClientMarkdown: string | null = null;
let lastClientPushedAt: string | null = null;

const appStatePostSchema = z.object({
  snapshot: z.object({
    timestamp: z.string(),
    route: z.object({
      hash: z.string(),
      path: z.string(),
      params: z.record(z.string()),
    }),
    viewport: z.object({ width: z.number(), height: z.number() }),
    stores: z.record(z.unknown()),
    recentErrors: z.array(
      z.object({
        timestamp: z.string(),
        message: z.string(),
        stack: z.string().optional(),
        source: z.string().optional(),
      }),
    ),
    storeOrder: z.array(z.string()),
  }),
  markdown: z.string(),
});

devRoutes.post(
  "/app-state",
  zValidator("json", appStatePostSchema),
  (c) => {
    const { snapshot, markdown } = c.req.valid("json");
    lastClientSnapshot = snapshot as ClientSnapshotShape;
    lastClientMarkdown = markdown;
    lastClientPushedAt = new Date().toISOString();
    return c.json({ ok: true });
  },
);

interface ServerSnapshot {
  timestamp: string;
  env: {
    nodeEnv: string;
    hostname: string;
    denoVersion: string;
  };
  recentRequests: DevRequestRecord[];
  recentErrors: DevErrorRecord[];
}

function collectServerSnapshot(): ServerSnapshot {
  return {
    timestamp: new Date().toISOString(),
    env: {
      nodeEnv: Deno.env.get("NODE_ENV") ?? "development",
      hostname: Deno.env.get("HOSTNAME") ?? "unknown",
      denoVersion: Deno.version.deno,
    },
    recentRequests: getRecentRequests(),
    recentErrors: getRecentErrors(),
  };
}

function formatServerMarkdown(server: ServerSnapshot): string {
  const lines: string[] = [
    "## Server Context",
    "",
    `**Timestamp:** ${server.timestamp}`,
    `**Env:** NODE_ENV=${server.env.nodeEnv} · Deno ${server.env.denoVersion} · ${server.env.hostname}`,
    "",
    `### Recent requests (${server.recentRequests.length})`,
    "",
  ];
  if (server.recentRequests.length === 0) {
    lines.push("_No requests captured yet._");
  } else {
    for (const r of server.recentRequests) {
      const tag = r.isError ? " 🔴" : "";
      lines.push(
        `- ${r.timestamp} \`${r.method} ${r.routePath}\` → ${r.status} (${r.durationMs}ms)${tag}`,
      );
    }
  }
  lines.push("", `### Recent server errors (${server.recentErrors.length})`, "");
  if (server.recentErrors.length === 0) {
    lines.push("_No server errors captured yet._");
  } else {
    for (const e of server.recentErrors) {
      lines.push(`- ${e.timestamp} [${e.source}]`);
      lines.push(`  ${e.message}`);
      if (e.request) {
        lines.push(
          `  during \`${e.request.method} ${e.request.routePath}\` → ${e.request.status}`,
        );
      }
    }
  }
  lines.push("");
  return lines.join("\n");
}

devRoutes.get("/app-state", (c) => {
  const server = collectServerSnapshot();
  const wantsMarkdown =
    c.req.query("format") === "markdown" ||
    c.req.header("accept")?.includes("text/markdown");

  const clientMarkdown = lastClientMarkdown ?? [
    "# Client App State Snapshot",
    "",
    "_No client snapshot received yet. Either the SPA isn't running, or " +
    "the dev-panel push pipeline hasn't fired its first heartbeat. See " +
    "web/src/lib/devpanel/init.ts._",
    "",
  ].join("\n");
  const serverMarkdown = formatServerMarkdown(server);
  const combinedMarkdown = `${clientMarkdown}\n\n---\n\n${serverMarkdown}`;

  if (wantsMarkdown) {
    return new Response(combinedMarkdown, {
      headers: { "Content-Type": "text/markdown; charset=utf-8" },
    });
  }

  return c.json({
    client: lastClientSnapshot,
    clientPushedAt: lastClientPushedAt,
    server,
    markdown: combinedMarkdown,
  });
});

export { devRoutes };
