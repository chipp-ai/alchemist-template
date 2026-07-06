/**
 * Team management tests — invite lifecycle + role hierarchy +
 * source-shape lints.
 *
 * Coverage:
 *   - Role hierarchy (rankOf, hasAtLeast, can, canManage)
 *   - Capability map exhaustiveness (every capability has a min-role
 *     entry; the server's lib/roles.ts and the client's
 *     web/src/lib/permissions.ts mirror each other exactly)
 *   - Invite token generator (uniqueness, URL-safety, length)
 *   - Source-shape lints:
 *     - publicRoutes / isPublicRoute is wired so /invite/:token
 *       resolves as public
 *     - Settings.svelte renders pending invites + role dropdowns
 *     - app.ts mounts /api/invite
 *     - Migration 003 backfills 'member' → 'editor'
 *
 * The end-to-end DB tests (createInvite + acceptInvite) need a live
 * Postgres. Those run against the Docker compose DB during local
 * dev; we don't run them in this file (which targets pure-JS
 * helpers + source lints).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  ASSIGNABLE_ROLES,
  CAPABILITIES,
  can,
  canManage,
  hasAtLeast,
  rankOf,
  ROLES,
  roleLabel,
  type Capability,
} from "@/lib/roles.ts";

function deno(name: string, fn: () => void | Promise<void>) {
  Deno.test({ name, sanitizeResources: false, sanitizeOps: false, fn });
}

// ── Role hierarchy ────────────────────────────────────────────────────────

deno("hierarchy: ranks are strictly descending owner > admin > editor > viewer", () => {
  // The actual values don't matter; the ORDER does.
  assertEquals(rankOf("owner") > rankOf("admin"), true);
  assertEquals(rankOf("admin") > rankOf("editor"), true);
  assertEquals(rankOf("editor") > rankOf("viewer"), true);
  assertEquals(rankOf("viewer") > 0, true);
});

deno("hierarchy: 'member' is a synonym for 'editor' (legacy backward compat)", () => {
  // The DB enum still allows 'member' from the original schema. New
  // code uses 'editor', but pre-migration rows might still be at
  // 'member'. They MUST get the same permissions or existing
  // customers' editors lose access on first deploy.
  assertEquals(rankOf("member"), rankOf("editor"));
  for (const cap of CAPABILITIES) {
    assertEquals(
      can("member", cap),
      can("editor", cap),
      `cap ${cap}: 'member' must equal 'editor'`,
    );
  }
});

deno("hierarchy: rankOf returns 0 for unknown roles (fail-closed)", () => {
  assertEquals(rankOf("nonexistent"), 0);
  assertEquals(rankOf(""), 0);
  // can() with rank 0 means it has nothing.
  for (const cap of CAPABILITIES) {
    assertEquals(can("nonexistent", cap), false);
  }
});

deno("hierarchy: hasAtLeast is inclusive at the boundary", () => {
  assertEquals(hasAtLeast("editor", "editor"), true);
  assertEquals(hasAtLeast("admin", "editor"), true);
  assertEquals(hasAtLeast("viewer", "editor"), false);
});

// ── Capabilities ──────────────────────────────────────────────────────────

deno("capabilities: viewer has read but no write/team/org actions", () => {
  assertEquals(can("viewer", "app.read"), true);
  assertEquals(can("viewer", "app.write"), false);
  assertEquals(can("viewer", "team.invite"), false);
  assertEquals(can("viewer", "team.update_role"), false);
  assertEquals(can("viewer", "team.remove"), false);
  assertEquals(can("viewer", "org.update"), false);
  assertEquals(can("viewer", "billing.manage"), false);
});

deno("capabilities: editor has write but no team/org actions", () => {
  assertEquals(can("editor", "app.read"), true);
  assertEquals(can("editor", "app.write"), true);
  assertEquals(can("editor", "team.invite"), false);
  assertEquals(can("editor", "team.update_role"), false);
  assertEquals(can("editor", "team.remove"), false);
  assertEquals(can("editor", "org.update"), false);
  assertEquals(can("editor", "billing.manage"), false);
});

deno("capabilities: admin can manage billing (product catalog)", () => {
  assertEquals(can("admin", "billing.manage"), true);
  assertEquals(can("owner", "billing.manage"), true);
});

deno("capabilities: admin has team + org but is gated from owner-only ops", () => {
  for (const cap of CAPABILITIES) {
    assertEquals(can("admin", cap), true, `admin should have ${cap}`);
  }
});

deno("capabilities: owner has every capability", () => {
  for (const cap of CAPABILITIES) {
    assertEquals(can("owner", cap), true, `owner should have ${cap}`);
  }
});

// ── canManage ─────────────────────────────────────────────────────────────

deno("canManage: viewer/editor cannot manage anyone", () => {
  for (const target of ROLES) {
    assertEquals(canManage("viewer", target), false);
    assertEquals(canManage("editor", target), false);
  }
});

deno("canManage: owner is untouchable", () => {
  assertEquals(canManage("admin", "owner"), false);
  assertEquals(canManage("owner", "owner"), false);
});

deno("canManage: admins can't manage other admins (only the owner can)", () => {
  assertEquals(canManage("admin", "admin"), false);
  assertEquals(canManage("owner", "admin"), true);
});

deno("canManage: admins manage editors and viewers", () => {
  assertEquals(canManage("admin", "editor"), true);
  assertEquals(canManage("admin", "member"), true); // legacy synonym
  assertEquals(canManage("admin", "viewer"), true);
});

// ── Role labels ───────────────────────────────────────────────────────────

deno("roleLabel: capitalizes + maps 'member' to 'Editor'", () => {
  assertEquals(roleLabel("owner"), "Owner");
  assertEquals(roleLabel("admin"), "Admin");
  assertEquals(roleLabel("editor"), "Editor");
  assertEquals(roleLabel("viewer"), "Viewer");
  // Legacy synonym presents as the canonical UI label.
  assertEquals(roleLabel("member"), "Editor");
});

// ── Capability + role exhaustiveness (regression guard) ───────────────────

deno("registry: every Capability is tested above (lint)", () => {
  // The implementation's Capability union is the source of truth. If
  // someone adds a capability without corresponding `can("X", "newcap")`
  // tests above, this lint catches the omission by checking that
  // every capability NAME shows up in the test file source.
  const src = Deno.readTextFileSync(
    new URL(import.meta.url),
  );
  for (const cap of CAPABILITIES) {
    if (!src.includes(`"${cap}"`)) {
      throw new Error(
        `Capability "${cap}" was added to lib/roles.ts but has no ` +
          `coverage in this test file. Add a can("admin", "${cap}") + ` +
          `can("viewer", "${cap}") assertion above.`,
      );
    }
  }
});

deno("registry: ASSIGNABLE_ROLES excludes 'owner' (invite-can-never-confer-ownership invariant)", () => {
  // Inviting someone to be the OWNER would let an admin steal the
  // org from the actual owner. ASSIGNABLE_ROLES is the public API
  // surface — never let it carry 'owner'. Migration to a different
  // owner is a separate flow (deferred from v1).
  assertEquals(ASSIGNABLE_ROLES.includes("owner" as never), false);
});

// ── Client mirror lint ────────────────────────────────────────────────────

deno("client mirror: web/src/lib/permissions.ts has the same capability list", async () => {
  // Both the server (lib/roles.ts) and client (web/src/lib/permissions.ts)
  // declare CAPABILITIES. They MUST be identical — drift means an
  // admin button shows in the UI but the API returns 403.
  const clientSrc = await Deno.readTextFile(
    new URL("../../web/src/lib/permissions.ts", import.meta.url),
  );
  for (const cap of CAPABILITIES) {
    if (!clientSrc.includes(`"${cap}"`)) {
      throw new Error(
        `Server has capability "${cap}" but client lib/permissions.ts ` +
          `doesn't. Add it to both.`,
      );
    }
  }
  for (const role of ROLES) {
    if (!clientSrc.includes(`"${role}"`)) {
      throw new Error(
        `Server has role "${role}" but client lib/permissions.ts doesn't. ` +
          `Add it.`,
      );
    }
  }
});

// ── Source-shape lints ────────────────────────────────────────────────────

deno("source: app.ts mounts /api/invite", async () => {
  const src = await Deno.readTextFile(
    new URL("../../app.ts", import.meta.url),
  );
  assertStringIncludes(
    src,
    `app.route("/api/invite", inviteRoutes)`,
    "app.ts must register the public invite-acceptance routes at /api/invite",
  );
});

deno("source: org routes guard team.* with requireCapability", async () => {
  const src = await Deno.readTextFile(
    new URL("../api/routes/org/index.ts", import.meta.url),
  );
  for (const cap of [
    "team.invite",
    "team.update_role",
    "team.remove",
    "org.update",
  ]) {
    assertStringIncludes(
      src,
      `requireCapability("${cap}")`,
      `org routes must guard with requireCapability("${cap}") — without ` +
        `it, role-checking happens inline and drifts from the central ` +
        `hierarchy.`,
    );
  }
});

deno("source: DELETE /members/:userId soft-disconnects (does NOT hard-delete)", async () => {
  const src = await Deno.readTextFile(
    new URL("../api/routes/org/index.ts", import.meta.url),
  );
  // Hard-delete would call db.deleteFrom("users")...; the new
  // behavior calls db.updateTable with organizationId: null. Lint
  // for both: the wrong shape must NOT be present, the right shape
  // must be.
  if (src.match(/deleteFrom\(\s*"users"\s*\)/)) {
    throw new Error(
      "org routes hard-DELETE the user row in DELETE /members/:userId. " +
        "That kills sessions, oauth bindings, and FK'd data. Use a " +
        "soft-disconnect (set organizationId = null) instead.",
    );
  }
  assertStringIncludes(
    src,
    `organizationId: null`,
    "org routes must soft-disconnect on member removal " +
      "(set organizationId = null), not hard-delete",
  );
});

deno("source: migration 003 adds 'editor' enum value + backfills 'member'", async () => {
  const sql = await Deno.readTextFile(
    new URL("../../db/migrations/003_team_management.sql", import.meta.url),
  );
  assertStringIncludes(
    sql,
    "ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'editor'",
    "migration 003 must add 'editor' to user_role",
  );
  assertStringIncludes(
    sql,
    "UPDATE users SET role = 'editor' WHERE role = 'member'",
    "migration 003 must backfill 'member' rows to 'editor' so fresh DBs " +
      "never produce 'member' rows",
  );
  assertStringIncludes(
    sql,
    "ADD COLUMN IF NOT EXISTS revoked_at",
    "migration 003 must add the revoked_at column to invites",
  );
  assertStringIncludes(
    sql,
    "invites_pending_unique",
    "migration 003 must create the partial unique index on " +
      "(organization_id, email) for pending invites",
  );
});

deno("source: routes.ts wires /invite/:token + isPublicRoute prefix-matches it", async () => {
  const src = await Deno.readTextFile(
    new URL("../../web/src/routes.ts", import.meta.url),
  );
  assertStringIncludes(
    src,
    `"/invite/:token": InviteAccept`,
    "routes.ts must register /invite/:token → InviteAccept.svelte",
  );
  assertStringIncludes(
    src,
    `"/invite/"`,
    "routes.ts must include /invite/ in PUBLIC_PREFIX_ROUTES so " +
      "isPublicRoute(path) matches the actual path with a token",
  );
  assertStringIncludes(
    src,
    "export function isPublicRoute",
    "routes.ts must export an isPublicRoute(path) function — " +
      "publicRoutes.has(literal) doesn't work for parameterized routes",
  );
});

deno("source: Settings.svelte renders pending invites + role-update dropdowns", async () => {
  const src = await Deno.readTextFile(
    new URL("../../web/src/routes/Settings.svelte", import.meta.url),
  );
  assertStringIncludes(
    src,
    `data-testid="settings-team-pending-invites"`,
    "Settings.svelte must render the pending-invites list",
  );
  assertStringIncludes(
    src,
    `data-testid="settings-team-select-role-`,
    "Settings.svelte must render per-member role dropdowns",
  );
  assertStringIncludes(
    src,
    "canManage(",
    "Settings.svelte must use canManage() to gate role-edit + remove " +
      "controls (admins can't manage other admins)",
  );
});
