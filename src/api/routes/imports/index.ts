/**
 * Import routes -- the four wizard steps, and the list of what can be
 * imported at all.
 *
 *   GET    /api/imports/definitions            what this app can import
 *   GET    /api/imports/definitions/:name      one, with its field specs
 *   GET    /api/imports/definitions/:name/sample.csv   a starter file
 *   POST   /api/imports/sessions               upload + parse + propose
 *   GET    /api/imports/sessions               recent runs
 *   GET    /api/imports/sessions/:id           one session's state
 *   PATCH  /api/imports/sessions/:id/mapping   confirm the mapping
 *   GET    /api/imports/sessions/:id/preview   normalized rows + counts
 *   POST   /api/imports/sessions/:id/commit    run it
 *
 * AUTHORIZATION IS PER DEFINITION, not per router. Each definition
 * declares the capability its import needs (`app.write` by default), and
 * every route that touches a definition checks that capability against
 * the caller's role before anything else happens. A blanket
 * `requireCapability` on the router would be wrong in both directions:
 * too weak for an import that writes payroll, too strong for one that
 * seeds a lookup table.
 *
 * The definitions list is the one exception. It is a menu, gated on auth
 * alone, and it marks each entry with whether THIS caller may run it, so
 * the wizard can grey out an import rather than hiding it and leaving a
 * person to wonder where it went.
 */

import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { validationHook } from "@/utils/zod-validation-hook.ts";
import { getUser, requireAuth } from "@/api/middleware/auth.ts";
import { can } from "@/lib/roles.ts";
import { BadRequestError, ForbiddenError, NotFoundError } from "@/utils/errors.ts";
import { MAX_UPLOAD_BYTES } from "@/utils/upload-types.ts";
import {
  definitionCapability,
  describeImportDefinition,
  findImportDefinition,
  getImportDefinition,
  type ImportDefinition,
  listImportDefinitions,
} from "@/services/import/definitions.ts";
import {
  commitImportSession,
  createImportSession,
  createImportSessionFromUpload,
  getImportSession,
  type ImportSession,
  listImportSessions,
  PREVIEW_ROW_LIMIT,
  previewImportSession,
  setImportSessionMapping,
} from "@/services/import/import.service.ts";
import { proposeMapping } from "@/services/import/mapping.ts";

const importRoutes = new Hono();

importRoutes.use("*", requireAuth);

const limitUploadBody = bodyLimit({
  maxSize: MAX_UPLOAD_BYTES,
  onError: () => {
    throw new BadRequestError(`The file exceeds the ${MAX_UPLOAD_BYTES} byte limit.`);
  },
});

/**
 * The definition's own capability, checked against this caller.
 *
 * Throws 403 rather than 404 on a real definition the caller may not
 * run: hiding it would be a lie the wizard has already contradicted by
 * listing it.
 */
function assertMayRun(def: ImportDefinition, role: string): void {
  if (!can(role, definitionCapability(def))) {
    throw new ForbiddenError(
      `Importing ${def.label} needs the ${definitionCapability(def)} permission.`,
    );
  }
}

function serializeSession(session: ImportSession) {
  return {
    id: session.id,
    definitionName: session.definitionName,
    filename: session.filename,
    status: session.status,
    sheetName: session.sheetName,
    headerRowIndex: session.headerRowIndex,
    columns: session.columns,
    mapping: session.mapping,
    rowCount: session.rowCount,
    result: session.result,
    createdBy: session.createdBy,
    committedAt: session.committedAt,
    createdAt: session.createdAt,
  };
}

// ── Definitions ────────────────────────────────────────────────────────────

importRoutes.get("/definitions", (c) => {
  const user = getUser(c);
  const definitions = listImportDefinitions().map((def) => ({
    ...describeImportDefinition(def),
    // Rendered as a disabled row with the reason, not hidden.
    canRun: can(user.role, definitionCapability(def)),
  }));
  return c.json({ data: definitions });
});

importRoutes.get("/definitions/:name", (c) => {
  const user = getUser(c);
  const def = getImportDefinition(c.req.param("name"));
  return c.json({
    data: {
      ...describeImportDefinition(def),
      canRun: can(user.role, definitionCapability(def)),
    },
  });
});

/**
 * A starter file with the right headings.
 *
 * Handing somebody the exact column names is the cheapest possible fix
 * for a mapping screen full of unmatched columns, and it costs one
 * function on the definition.
 */
importRoutes.get("/definitions/:name/sample.csv", (c) => {
  const def = getImportDefinition(c.req.param("name"));
  if (!def.sampleCsv) throw new NotFoundError("Sample file");
  return new Response(def.sampleCsv(), {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${def.name}-sample.csv"`,
    },
  });
});

/**
 * What a mapping proposal WOULD look like for a set of headings.
 *
 * No file, no session, no storage. It exists so the mapping rules can be
 * exercised from a script or a test without a round trip through an
 * upload, and so a person pasting their header row can see whether their
 * spreadsheet will map before they upload anything.
 */
const proposeSchema = z.object({
  columns: z.array(z.string().max(300)).min(1).max(200),
});

importRoutes.post(
  "/definitions/:name/propose-mapping",
  zValidator("json", proposeSchema, validationHook),
  (c) => {
    const user = getUser(c);
    const def = getImportDefinition(c.req.param("name") ?? "");
    assertMayRun(def, user.role);
    return c.json({ data: proposeMapping(c.req.valid("json").columns, def) });
  },
);

// ── Sessions ───────────────────────────────────────────────────────────────

const sessionFromUploadSchema = z.object({
  definition: z.string().trim().min(1).max(120),
  /** A file already stored by POST /api/files/uploads. */
  uploadedFileId: z.string().uuid(),
  sheetName: z.string().trim().max(200).nullish(),
  headerRowIndex: z.number().int().min(0).max(999).nullish(),
});

/**
 * Open a session.
 *
 * TWO WAYS IN, one flow after that.
 *
 *   JSON { definition, uploadedFileId }   the wizard's path. <UploadField>
 *   has already posted the file to /api/files/uploads, with the progress
 *   bar and the allowlist and the row that every other upload in this app
 *   gets. A second upload endpoint here would be a second copy of all of
 *   that.
 *
 *   multipart { file, definition }        one call for a script, a
 *   migration, or a test: bytes in, session out.
 */
importRoutes.post("/sessions", limitUploadBody, async (c) => {
  const user = getUser(c);

  const contentType = c.req.header("content-type") ?? "";

  if (contentType.startsWith("application/json")) {
    const parsed = sessionFromUploadSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      throw new BadRequestError(parsed.error.issues[0]?.message ?? "Invalid request body.");
    }

    const def = findImportDefinition(parsed.data.definition);
    if (!def) throw new NotFoundError("Import definition", parsed.data.definition);
    assertMayRun(def, user.role);

    const { session, proposal } = await createImportSessionFromUpload({
      organizationId: user.organizationId,
      userId: user.id,
      definitionName: def.name,
      uploadedFileId: parsed.data.uploadedFileId,
      sheetName: parsed.data.sheetName ?? undefined,
      headerRowIndex: parsed.data.headerRowIndex ?? undefined,
    });

    return c.json({ data: { session: serializeSession(session), proposal } }, 201);
  }

  if (!contentType.startsWith("multipart/form-data")) {
    throw new BadRequestError(
      "Send JSON with `definition` and `uploadedFileId`, or multipart/form-data with a `file`.",
    );
  }

  const form = await c.req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) {
    throw new BadRequestError("`file` field is required and must be a file.");
  }

  const definitionName = String(form.get("definition") ?? "").trim();
  if (!definitionName) throw new BadRequestError("`definition` field is required.");
  const def = findImportDefinition(definitionName);
  if (!def) throw new NotFoundError("Import definition", definitionName);
  assertMayRun(def, user.role);

  const sheetName = String(form.get("sheetName") ?? "").trim() || undefined;
  const headerRowRaw = String(form.get("headerRowIndex") ?? "").trim();
  const headerRowIndex = headerRowRaw === "" ? undefined : Number(headerRowRaw);
  if (headerRowIndex !== undefined && !Number.isInteger(headerRowIndex)) {
    throw new BadRequestError("`headerRowIndex` must be a whole number.");
  }

  const { session, proposal } = await createImportSession({
    organizationId: user.organizationId,
    userId: user.id,
    definitionName: def.name,
    filename: file.name,
    contentType: file.type,
    body: new Uint8Array(await file.arrayBuffer()),
    sheetName,
    headerRowIndex,
  });

  return c.json({ data: { session: serializeSession(session), proposal } }, 201);
});

importRoutes.get("/sessions", async (c) => {
  const user = getUser(c);
  const sessions = await listImportSessions({
    organizationId: user.organizationId,
    definitionName: c.req.query("definition") || undefined,
    limit: Number(c.req.query("limit") ?? 20) || 20,
  });
  return c.json({ data: sessions.map(serializeSession) });
});

importRoutes.get("/sessions/:id", async (c) => {
  const user = getUser(c);
  const session = await getImportSession({
    id: c.req.param("id"),
    organizationId: user.organizationId,
  });
  assertMayRun(getImportDefinition(session.definitionName), user.role);
  return c.json({ data: serializeSession(session) });
});

const mappingSchema = z.object({
  mapping: z
    .array(
      z.object({
        columnIndex: z.number().int().min(0).max(999),
        fieldKey: z.string().trim().min(1).max(120).nullish(),
        // Nullish, not optional: the mapping screen blanks this field
        // when a person switches a column from "keep as" back to "skip",
        // and a blanked field arrives as null.
        custom: z.string().trim().max(64).nullish(),
      }),
    )
    .max(200),
});

importRoutes.patch(
  "/sessions/:id/mapping",
  zValidator("json", mappingSchema, validationHook),
  async (c) => {
    const user = getUser(c);
    const id = c.req.param("id") ?? "";
    const existing = await getImportSession({ id, organizationId: user.organizationId });
    assertMayRun(getImportDefinition(existing.definitionName), user.role);

    const session = await setImportSessionMapping({
      id,
      organizationId: user.organizationId,
      entries: c.req.valid("json").mapping.map((entry) => ({
        columnIndex: entry.columnIndex,
        fieldKey: entry.fieldKey ?? null,
        custom: entry.custom ?? null,
      })),
    });

    return c.json({ data: serializeSession(session) });
  },
);

importRoutes.get("/sessions/:id/preview", async (c) => {
  const user = getUser(c);
  const id = c.req.param("id");
  const session = await getImportSession({ id, organizationId: user.organizationId });
  assertMayRun(getImportDefinition(session.definitionName), user.role);

  const limitRaw = Number(c.req.query("limit") ?? PREVIEW_ROW_LIMIT);
  const preview = await previewImportSession({
    id,
    organizationId: user.organizationId,
    limit: Number.isFinite(limitRaw) ? limitRaw : PREVIEW_ROW_LIMIT,
  });

  return c.json({ data: preview });
});

importRoutes.post("/sessions/:id/commit", async (c) => {
  const user = getUser(c);
  const id = c.req.param("id");
  const existing = await getImportSession({ id, organizationId: user.organizationId });
  assertMayRun(getImportDefinition(existing.definitionName), user.role);

  const { session, result } = await commitImportSession({
    id,
    organizationId: user.organizationId,
    userId: user.id,
  });

  return c.json({ data: { session: serializeSession(session), result } });
});

export { importRoutes };
