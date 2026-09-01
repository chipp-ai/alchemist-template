/**
 * Import definitions -- the ONE thing an app writes to get a spreadsheet
 * importer. Register a definition; never rebuild the wizard.
 *
 * "Let them upload a spreadsheet" is the single most-rebuilt feature in
 * customer apps, and every rebuild re-derives the same six problems:
 * header detection, column mapping, per-cell validation, telling a new
 * record apart from an edit to an existing one, duplicates inside the
 * file, and reporting honestly on what did not land. All six live in
 * this framework. What it cannot know is YOUR table, so that is what a
 * definition supplies:
 *
 *   registerImportDefinition({
 *     name: "people",
 *     label: "People",
 *     description: "Staff roster: name, email, start date.",
 *     fields: [
 *       { key: "fullName", label: "Full name", kind: "text", inputOnly: true,
 *         aliases: ["name", "employee"] },
 *       { key: "firstName", label: "First name", kind: "text", required: true },
 *       { key: "lastName",  label: "Last name",  kind: "text" },
 *       { key: "email",     label: "Email",      kind: "email", required: true },
 *       { key: "startDate", label: "Start date", kind: "date" },
 *     ],
 *     derive: [splitFullName({ from: "fullName", first: "firstName", last: "lastName" })],
 *     matchBy: [["email"], ["firstName", "lastName"]],
 *     loadExisting: ({ organizationId }) => ...,
 *     upsertRow: ({ trx, organizationId, values, existingId }) => ...,
 *   });
 *
 * Register from a module `main.ts` imports (same rule as the email kind
 * registry and the inbound-email extraction profile) or the routes will
 * not see it.
 *
 * THE FOUR PARTS, and what each one buys:
 *
 *   fields       what a spreadsheet column may be mapped to. `aliases`
 *                is what makes "Work E-Mail" land on `email` without
 *                anybody touching a dropdown.
 *   derive       row-level rewrites that run before validation. The
 *                built-in `splitFullName` covers the case every roster
 *                import hits: one "Name" column, two columns in the DB.
 *   matchBy      how a row in the file is recognised as a record you
 *                already have. Ordered: the first tuple that matches
 *                wins. This is what makes a re-import an UPDATE instead
 *                of a second copy of everybody.
 *   upsertRow    your write, inside the framework's transaction.
 *
 * ORG SCOPING IS YOURS TO APPLY. `loadExisting` and `upsertRow` are both
 * handed an `organizationId` and both MUST use it in their WHERE clause
 * (CWE-639). The framework does not re-scope the rows you return or the
 * row you write.
 */

import type { Capability } from "@/lib/roles.ts";
import type { UploadTypeId } from "@/utils/upload-types.ts";
import type { Kysely } from "kysely";
import type { Database } from "@/db/schema.ts";
import { log } from "@/lib/logger.ts";
import { NotFoundError } from "@/utils/errors.ts";

const LOG_SOURCE = "imports";

// ── Values ─────────────────────────────────────────────────────────────────

/** What one normalized cell can be. `null` is "the cell was empty". */
export type ImportValue = string | number | boolean | null;

export type ImportRowValues = Record<string, ImportValue>;

// ── Fields ─────────────────────────────────────────────────────────────────

export type ImportFieldKind = "text" | "email" | "date" | "enum" | "number" | "boolean";

export interface ImportFieldSpec {
  /** Machine key. What `upsertRow` receives, and what `matchBy` names. */
  key: string;
  /** Column heading in the mapping and preview screens. */
  label: string;
  kind: ImportFieldKind;
  /** Checked AFTER derivations, so a derived field can satisfy it. */
  required?: boolean;
  /**
   * Other headings that mean this field. Matched case-, space- and
   * punctuation-insensitively, so "Work E-Mail" needs no alias if
   * "email" is already the key -- add aliases for genuinely different
   * words ("staff no", "payroll id").
   */
  aliases?: readonly string[];
  /** `enum` only. Matched case-insensitively; the stored value is this one. */
  options?: readonly string[];
  /** `text` / `email` only. Longer values are an error, never a silent cut. */
  maxLength?: number;
  /**
   * `date` only. Which way to read `3/4/2026`. There is no way to tell
   * from the file, so the definition says. Defaults to month-first.
   */
  dateOrder?: "mdy" | "dmy";
  /**
   * True when this field exists only to feed a derivation. It is
   * mappable and validated, but it is NOT passed to `upsertRow`: a
   * "Full name" column that splits into first and last has no column of
   * its own in the table.
   */
  inputOnly?: boolean;
  /** One line under the field name in the mapping screen. */
  help?: string;
}

// ── Derivations ────────────────────────────────────────────────────────────

export interface ImportDerivation {
  /** Field keys this rewrite reads. */
  from: readonly string[];
  /** Field keys it may write. Used by required-ness and by the UI. */
  produces: readonly string[];
  /**
   * Return only the keys you are setting. The framework applies them
   * over the row, and NEVER over a key the file already filled: an
   * explicit "First name" column always beats a name split out of
   * "Full name".
   */
  run(values: Readonly<ImportRowValues>): ImportRowValues;
}

/**
 * The derivation every roster import needs: one "Name" column, two
 * columns in the table.
 *
 * The split is the last space, not the first: "Ana Maria Ruiz Diaz"
 * keeps "Ana Maria Ruiz" as the given names and "Diaz" as the family
 * name. That is wrong for some names, and there is no rule that is right
 * for all of them, so it is a starting point a person can correct in the
 * preview rather than a claim to have solved names.
 *
 * A comma flips it: "Ruiz, Ana" is the other convention exports use, and
 * it IS unambiguous, so it is honoured.
 */
export function splitFullName(opts: {
  from: string;
  first: string;
  last: string;
}): ImportDerivation {
  return {
    from: [opts.from],
    produces: [opts.first, opts.last],
    run(values) {
      const raw = values[opts.from];
      if (typeof raw !== "string") return {};
      const full = raw.trim().replace(/\s+/g, " ");
      if (!full) return {};

      const comma = full.indexOf(",");
      if (comma > 0) {
        const last = full.slice(0, comma).trim();
        const first = full.slice(comma + 1).trim();
        if (last && first) return { [opts.first]: first, [opts.last]: last };
      }

      const space = full.lastIndexOf(" ");
      if (space < 0) return { [opts.first]: full };
      return {
        [opts.first]: full.slice(0, space).trim(),
        [opts.last]: full.slice(space + 1).trim(),
      };
    },
  };
}

// ── Existing records + upsert ──────────────────────────────────────────────

/**
 * One record the app already has, in the definition's own field keys.
 * Only the keys named in `matchBy` are read; anything else is ignored.
 */
export interface ExistingRecord {
  id: string;
  values: ImportRowValues;
}

export interface LoadExistingOptions {
  organizationId: string;
  /**
   * The rows about to be imported, already normalized. Narrow your query
   * with these (`WHERE email IN (...)`) when the table is large. Loading
   * everything is fine for a table of a few thousand rows and is what
   * the example definition does.
   */
  rows: readonly ImportRowValues[];
}

export interface UpsertRowOptions {
  /**
   * The framework's OPEN TRANSACTION. Every write must go through it,
   * never through the module-level `db`: a write on the outer connection
   * does not roll back with the rest of the import, so a failure halfway
   * through would leave part of the file applied and no record of which
   * part. (Typed as `Kysely<Database>` because that is what the
   * transaction helper hands back; it is a transaction.)
   */
  trx: Kysely<Database>;
  organizationId: string;
  /** Who ran the import. NULL for a system-triggered run. */
  userId: string | null;
  /** Normalized, derived, validated. `inputOnly` fields are not here. */
  values: ImportRowValues;
  /**
   * Columns the person mapped to "custom" rather than to a field. Keyed
   * by the name they gave. Store them, ignore them, or reject them.
   */
  extras: Record<string, string>;
  /** The id `matchBy` resolved to, or null for a new record. */
  existingId: string | null;
  /** 1-based row number in the file, for your own logging. */
  rowNumber: number;
}

// ── The definition ─────────────────────────────────────────────────────────

export interface ImportDefinition {
  /** Stable machine name. Appears in URLs and in the session row. */
  name: string;
  /** Shown in the wizard's picker. */
  label: string;
  /** One or two lines: what this import does to the app's data. */
  description: string;
  fields: readonly ImportFieldSpec[];
  /**
   * How a file row is recognised as an existing record, best first. Each
   * entry is a tuple of field keys that must ALL be present and must ALL
   * match. `[["email"], ["firstName", "lastName"]]` reads as: match on
   * email; failing that, match on the exact first and last name pair.
   *
   * Matching is case-insensitive and whitespace-collapsed on both sides.
   * An empty list means every row is a create, which is almost never
   * what an app wants: it is how a re-import doubles the table.
   */
  matchBy: readonly (readonly string[])[];
  derive?: readonly ImportDerivation[];
  /** Who may run this import. Defaults to `app.write`. */
  capability?: Capability;
  /** File types accepted. Defaults to CSV and XLSX. Narrows only. */
  allow?: readonly UploadTypeId[];
  loadExisting(opts: LoadExistingOptions): Promise<ExistingRecord[]>;
  upsertRow(opts: UpsertRowOptions): Promise<{ id: string }>;
  /** A downloadable starter file. Shown in the wizard's first step. */
  sampleCsv?(): string;
}

// ── Registry ───────────────────────────────────────────────────────────────

const registry = new Map<string, ImportDefinition>();

/**
 * Register one definition.
 *
 * Throws on a duplicate name and on a definition that contradicts
 * itself, at REGISTRATION time rather than at the first import. Both
 * checks exist because the alternative is a wizard that renders a
 * dropdown of fields where one silently does nothing.
 */
export function registerImportDefinition(def: ImportDefinition): void {
  if (registry.has(def.name)) {
    throw new Error(`Import definition "${def.name}" is already registered.`);
  }
  assertDefinitionIsCoherent(def);
  registry.set(def.name, def);
  log.info("Import definition registered", {
    source: LOG_SOURCE,
    feature: "register",
    definition: def.name,
    fieldCount: def.fields.length,
  });
}

/** Test seam. Never call this from application code. */
export function clearImportDefinitions(): void {
  registry.clear();
}

export function listImportDefinitions(): ImportDefinition[] {
  return [...registry.values()].sort((a, b) => a.label.localeCompare(b.label));
}

export function findImportDefinition(name: string): ImportDefinition | null {
  return registry.get(name) ?? null;
}

export function getImportDefinition(name: string): ImportDefinition {
  const def = registry.get(name);
  if (!def) {
    throw new NotFoundError("Import definition", `No import named "${name}" is registered.`);
  }
  return def;
}

/**
 * Everything a definition claims must line up with its own field list.
 *
 * A `matchBy` naming a key that does not exist would silently never
 * match, so every re-import would duplicate the whole file. A derivation
 * producing an unknown key would write a value nothing reads. An enum
 * field with no options can never be satisfied. Each of these is a
 * defect that only shows up in the data, days later.
 */
function assertDefinitionIsCoherent(def: ImportDefinition): void {
  const keys = new Set(def.fields.map((f) => f.key));

  if (def.fields.length === 0) {
    throw new Error(`Import definition "${def.name}" has no fields.`);
  }
  if (keys.size !== def.fields.length) {
    throw new Error(`Import definition "${def.name}" has duplicate field keys.`);
  }

  for (const field of def.fields) {
    if (field.kind === "enum" && (!field.options || field.options.length === 0)) {
      throw new Error(
        `Import definition "${def.name}": field "${field.key}" is an enum with no options.`,
      );
    }
  }

  for (const tuple of def.matchBy) {
    if (tuple.length === 0) {
      throw new Error(`Import definition "${def.name}" has an empty matchBy tuple.`);
    }
    for (const key of tuple) {
      if (!keys.has(key)) {
        throw new Error(
          `Import definition "${def.name}": matchBy names "${key}", which is not a field.`,
        );
      }
    }
  }

  for (const derivation of def.derive ?? []) {
    for (const key of [...derivation.from, ...derivation.produces]) {
      if (!keys.has(key)) {
        throw new Error(
          `Import definition "${def.name}": a derivation names "${key}", which is not a field.`,
        );
      }
    }
  }

  // A required field nothing can fill is a wizard nobody can finish.
  const derivable = new Set((def.derive ?? []).flatMap((d) => [...d.produces]));
  for (const field of def.fields) {
    if (field.required && field.inputOnly && !derivable.has(field.key)) {
      throw new Error(
        `Import definition "${def.name}": field "${field.key}" is required and input-only ` +
          `but no derivation produces it.`,
      );
    }
  }
}

// ── Field helpers, shared by the mapper, the preview, and the routes ───────

export function fieldsByKey(def: ImportDefinition): Map<string, ImportFieldSpec> {
  return new Map(def.fields.map((f) => [f.key, f]));
}

/** Fields whose value reaches `upsertRow`. */
export function targetFields(def: ImportDefinition): ImportFieldSpec[] {
  return def.fields.filter((f) => !f.inputOnly);
}

/** File types this definition will take. Never wider than the allowlist. */
export function definitionUploadTypes(def: ImportDefinition): readonly UploadTypeId[] {
  return def.allow ?? (["csv", "xlsx"] as const);
}

export function definitionCapability(def: ImportDefinition): Capability {
  return def.capability ?? "app.write";
}

/**
 * The public shape of a definition: what the wizard renders. Never
 * includes the handlers, which are server-side code.
 */
export function describeImportDefinition(def: ImportDefinition) {
  return {
    name: def.name,
    label: def.label,
    description: def.description,
    capability: definitionCapability(def),
    acceptTypes: definitionUploadTypes(def),
    matchBy: def.matchBy.map((tuple) => [...tuple]),
    hasSample: typeof def.sampleCsv === "function",
    fields: def.fields.map((f) => ({
      key: f.key,
      label: f.label,
      kind: f.kind,
      required: f.required === true,
      inputOnly: f.inputOnly === true,
      options: f.options ? [...f.options] : null,
      help: f.help ?? null,
      aliases: f.aliases ? [...f.aliases] : [],
    })),
  };
}

export type ImportDefinitionDescription = ReturnType<typeof describeImportDefinition>;
