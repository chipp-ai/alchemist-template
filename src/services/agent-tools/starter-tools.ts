/**
 * Starter agent tools over the template's base features: the signed-in
 * user, the team, uploaded files and portal bindings, plus one write
 * example (rename yourself).
 *
 * Copy this file's shape when you add a feature: one registerAgentTool per
 * route the agent should reach, scoped by ctx.user, writes marked
 * write: true. See src/services/agent-tools/registry.ts for the rules.
 */

import { db } from "@/db/client.ts";
import { registerAgentTool } from "@/services/agent-tools/registry.ts";
import {
  assertCanReadUploadedFile,
  getUploadedFile,
  listVisibleUploadedFiles,
  type UploadedFile,
} from "@/services/uploaded-file.service.ts";
import { listPortalAccessForUser } from "@/services/portal-access.service.ts";
import { log } from "@/lib/logger.ts";
import { BadRequestError } from "@/utils/errors.ts";

/** The file fields an agent sees. The storage key stays server-side. */
function fileSummary(f: UploadedFile) {
  return {
    id: f.id,
    filename: f.filename,
    contentType: f.contentType,
    sizeBytes: f.sizeBytes,
    status: f.status,
    subjectType: f.subjectType,
    subjectId: f.subjectId,
    uploadedBy: f.uploadedBy,
    createdAt: f.createdAt.toISOString(),
  };
}

registerAgentTool({
  name: "get_current_user",
  description: "Who the signed-in user is: id, email, name, role, and their organization. " +
    "Call this first when you need to know who you are acting for.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  capability: "app.read",
  write: false,
  portalSafe: true,
  handler: async ({ user, portalBindings }) => {
    const org = await db
      .selectFrom("organizations")
      .select(["id", "name", "slug"])
      .where("id", "=", user.organizationId)
      .executeTakeFirst();
    return {
      user: { id: user.id, email: user.email, name: user.name, role: user.role },
      organization: org ?? null,
      portalUser: portalBindings.length > 0,
    };
  },
});

registerAgentTool({
  name: "list_team_members",
  description: "List the people in the user's organization with their roles, oldest member first.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  capability: "app.read",
  write: false,
  handler: async ({ user }) => {
    const members = await db
      .selectFrom("users")
      .select(["id", "email", "name", "role", "createdAt"])
      .where("organizationId", "=", user.organizationId)
      .orderBy("createdAt", "asc")
      .limit(500)
      .execute();
    return {
      members: members.map((m) => ({ ...m, createdAt: m.createdAt.toISOString() })),
    };
  },
});

registerAgentTool({
  name: "list_files",
  description: "List uploaded files the user can see in their organization, newest first. " +
    "Returns metadata only (no file contents).",
  inputSchema: {
    type: "object",
    properties: {
      status: {
        type: "string",
        enum: ["pending_review", "approved", "rejected"],
        description: "Only files in this review state.",
      },
      limit: { type: "integer", minimum: 1, maximum: 100, description: "Default 25." },
    },
    additionalProperties: false,
  },
  capability: "app.read",
  write: false,
  handler: async ({ user }, args) => {
    const files = await listVisibleUploadedFiles({
      organizationId: user.organizationId,
      viewer: { id: user.id, role: user.role },
      status: args.status,
      limit: args.limit ?? 25,
    });
    return { files: files.map(fileSummary) };
  },
});

registerAgentTool({
  name: "get_file",
  description: "Metadata for one uploaded file by id (no file contents).",
  inputSchema: {
    type: "object",
    properties: { fileId: { type: "string", format: "uuid", description: "The file id." } },
    required: ["fileId"],
    additionalProperties: false,
  },
  capability: "app.read",
  write: false,
  handler: async ({ user }, args) => {
    // Org-scoped in the WHERE clause: another org's id is "not found".
    const file = await getUploadedFile({ id: args.fileId, organizationId: user.organizationId });
    assertCanReadUploadedFile(file, { id: user.id, role: user.role });
    return { file: fileSummary(file) };
  },
});

registerAgentTool({
  name: "list_my_portal_records",
  description: "The records this user was given portal access to (subject type and id). " +
    "For a portal user this is everything they may see.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  capability: "app.read",
  write: false,
  portalSafe: true,
  handler: async ({ user }) => {
    const access = await listPortalAccessForUser(user.id);
    return {
      records: access
        .filter((a) => a.organizationId === user.organizationId)
        .map((a) => ({ subjectType: a.subjectType, subjectId: a.subjectId })),
    };
  },
});

registerAgentTool({
  name: "update_my_profile",
  description:
    "Change the signed-in user's own display name. Changes data: the person confirms first.",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", minLength: 1, maxLength: 100, description: "The new display name." },
    },
    required: ["name"],
    additionalProperties: false,
  },
  // Same gate as PATCH /api/auth/me: any signed-in user may rename
  // themselves, a viewer and a portal user included. It touches only
  // their own row.
  capability: "app.read",
  write: true,
  portalSafe: true,
  handler: async ({ user }, args) => {
    const name = String(args.name).trim();
    if (!name) throw new BadRequestError("name must not be blank");
    const updated = await db
      .updateTable("users")
      .set({ name })
      .where("id", "=", user.id)
      .where("organizationId", "=", user.organizationId)
      .returning(["id", "email", "name"])
      .executeTakeFirstOrThrow();
    log.info("Profile updated by agent", {
      source: "agent-tools",
      feature: "update_my_profile",
      userId: user.id,
    });
    return { user: updated };
  },
});
