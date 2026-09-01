/**
 * Column mapping and identity matching.
 *
 * TWO KINDS OF MATCHING LIVE HERE, and they are easy to confuse.
 *
 *   proposeMapping   matches the file's COLUMN HEADINGS to the
 *                    definition's fields. It runs once, before anybody
 *                    sees a preview, and its whole job is to make the
 *                    mapping screen already correct so a person confirms
 *                    rather than fills in.
 *
 *   matchIdentities  matches the file's ROWS to records the app already
 *                    has, using the definition's `matchBy` tuples. This
 *                    is what makes a re-import an update instead of a
 *                    second copy of everybody, and what finds two rows
 *                    for the same person inside one file.
 *
 * The header match runs in three passes, widest confidence first, and
 * each pass only considers columns and fields still unclaimed:
 *
 *   exact    the heading IS the field's key or label, ignoring case
 *   alias    the heading is one of the field's declared aliases
 *   fuzzy    the heading squashes to the same string as the key, the
 *            label or an alias, where squashing drops case, spaces and
 *            punctuation: "Work E-Mail" -> "workemail"
 *
 * A column that two fields could claim in the same pass is left
 * UNMAPPED and marked ambiguous, with both candidates named. Guessing
 * between two equally good answers is how an import silently writes a
 * phone number into an address column.
 */

import type { ImportDefinition, ImportFieldSpec } from "./definitions.ts";
import { squash } from "./normalize.ts";
import type { ExistingRecord, ImportRowValues, ImportValue } from "./definitions.ts";

export type MappingConfidence = "exact" | "alias" | "fuzzy" | "none";

export interface ColumnProposal {
  /** Index into the parsed `columns` array. The mapping is keyed by this. */
  columnIndex: number;
  columnLabel: string;
  /** The field this column will fill, or null for "skip". */
  fieldKey: string | null;
  confidence: MappingConfidence;
  /**
   * True when more than one field matched this heading equally well.
   * The column is left unmapped: a person picks.
   */
  ambiguous: boolean;
  /** Field keys that tied, when ambiguous. Empty otherwise. */
  candidates: string[];
}

/** What the client sends back: one entry per column it wants to use. */
export interface ColumnMappingEntry {
  columnIndex: number;
  /** A field key, or null to skip this column. */
  fieldKey: string | null;
  /**
   * Keep the column as free-form extra data under this name instead of
   * mapping it to a field. Ignored unless `fieldKey` is null.
   */
  custom?: string | null;
}

// ── Header matching ────────────────────────────────────────────────────────

export function proposeMapping(
  columns: readonly string[],
  def: ImportDefinition,
): ColumnProposal[] {
  const proposals: ColumnProposal[] = columns.map((label, columnIndex) => ({
    columnIndex,
    columnLabel: label,
    fieldKey: null,
    confidence: "none",
    ambiguous: false,
    candidates: [],
  }));

  const claimedFields = new Set<string>();

  for (const pass of ["exact", "alias", "fuzzy"] as const) {
    // Collected first, applied after: a field claimed mid-pass would
    // make the result depend on column order within a single tier.
    const decisions: Array<{ index: number; fieldKey: string }> = [];

    for (const proposal of proposals) {
      if (proposal.fieldKey || proposal.ambiguous) continue;

      const hits = def.fields.filter(
        (field) =>
          !claimedFields.has(field.key) && matchesAtTier(proposal.columnLabel, field, pass),
      );

      if (hits.length === 1) {
        decisions.push({ index: proposal.columnIndex, fieldKey: hits[0].key });
        proposal.confidence = pass;
      } else if (hits.length > 1) {
        proposal.ambiguous = true;
        proposal.candidates = hits.map((f) => f.key);
      }
    }

    // Two columns wanting the same field is the mirror case: neither
    // gets it, both are ambiguous, and a person decides which heading
    // really is "Email".
    const perField = new Map<string, number[]>();
    for (const d of decisions) {
      perField.set(d.fieldKey, [...(perField.get(d.fieldKey) ?? []), d.index]);
    }

    for (const [fieldKey, indexes] of perField) {
      if (indexes.length === 1) {
        proposals[indexes[0]].fieldKey = fieldKey;
        claimedFields.add(fieldKey);
      } else {
        for (const index of indexes) {
          proposals[index].confidence = "none";
          proposals[index].ambiguous = true;
          proposals[index].candidates = [fieldKey];
        }
      }
    }
  }

  return proposals;
}

function matchesAtTier(
  heading: string,
  field: ImportFieldSpec,
  tier: "exact" | "alias" | "fuzzy",
): boolean {
  const trimmed = heading.trim();
  const lower = trimmed.toLowerCase();

  if (tier === "exact") {
    return lower === field.key.toLowerCase() || lower === field.label.toLowerCase();
  }
  if (tier === "alias") {
    return (field.aliases ?? []).some((alias) => alias.trim().toLowerCase() === lower);
  }

  const squashed = squash(trimmed);
  if (!squashed) return false;
  if (squashed === squash(field.key) || squashed === squash(field.label)) return true;
  return (field.aliases ?? []).some((alias) => squash(alias) === squashed);
}

/**
 * Turn a client-supplied mapping into the lookup the row normalizer
 * needs, refusing anything incoherent.
 *
 * Refusals rather than silent drops, because each one is a mapping
 * screen that would have looked fine and imported the wrong thing: a
 * field mapped twice means one of the two columns is quietly discarded,
 * and an unknown field key means a column that appears mapped and is
 * not.
 */
export function resolveMapping(
  entries: readonly ColumnMappingEntry[],
  columns: readonly string[],
  def: ImportDefinition,
): { byColumn: Map<number, { fieldKey: string | null; custom: string | null }>; errors: string[] } {
  const known = new Set(def.fields.map((f) => f.key));
  const byColumn = new Map<number, { fieldKey: string | null; custom: string | null }>();
  const usedFields = new Map<string, number>();
  const usedCustom = new Set<string>();
  const errors: string[] = [];

  for (const entry of entries) {
    if (!Number.isInteger(entry.columnIndex) || entry.columnIndex < 0) {
      errors.push(`Column ${entry.columnIndex} is not a column in this file.`);
      continue;
    }
    if (entry.columnIndex >= columns.length) {
      errors.push(
        `This file has ${columns.length} columns, so there is no column ${entry.columnIndex + 1}.`,
      );
      continue;
    }
    if (byColumn.has(entry.columnIndex)) {
      errors.push(`Column "${columns[entry.columnIndex]}" is mapped twice.`);
      continue;
    }

    if (entry.fieldKey) {
      if (!known.has(entry.fieldKey)) {
        errors.push(`"${entry.fieldKey}" is not a field of this import.`);
        continue;
      }
      const already = usedFields.get(entry.fieldKey);
      if (already !== undefined) {
        errors.push(
          `Both "${columns[already]}" and "${
            columns[entry.columnIndex]
          }" are mapped to ${entry.fieldKey}. Pick one.`,
        );
        continue;
      }
      usedFields.set(entry.fieldKey, entry.columnIndex);
      byColumn.set(entry.columnIndex, { fieldKey: entry.fieldKey, custom: null });
      continue;
    }

    const custom = (entry.custom ?? "").trim();
    if (custom) {
      const name = custom.slice(0, 64);
      if (usedCustom.has(name.toLowerCase())) {
        errors.push(`Two columns are both kept as "${name}". Give them different names.`);
        continue;
      }
      usedCustom.add(name.toLowerCase());
      byColumn.set(entry.columnIndex, { fieldKey: null, custom: name });
      continue;
    }

    byColumn.set(entry.columnIndex, { fieldKey: null, custom: null });
  }

  for (const field of def.fields) {
    if (field.required && !usedFields.has(field.key) && !producedByDerivation(def, field.key)) {
      errors.push(`${field.label} is required, so a column has to be mapped to it.`);
    }
  }

  return { byColumn, errors };
}

/**
 * A required field is also satisfied by a derivation, but only if the
 * derivation's own inputs are mapped. `firstName` split out of a
 * "Full name" column is fine; split out of a column nobody mapped is
 * not, and that is a mapping screen a person can still fix.
 */
function producedByDerivation(def: ImportDefinition, fieldKey: string): boolean {
  return (def.derive ?? []).some((d) => d.produces.includes(fieldKey));
}

/** Which columns feed which field, ready for the row normalizer. */
export function rowCells(
  row: readonly string[],
  byColumn: Map<number, { fieldKey: string | null; custom: string | null }>,
): { cells: Record<string, string>; extras: Record<string, string> } {
  const cells: Record<string, string> = {};
  const extras: Record<string, string> = {};
  for (const [columnIndex, target] of byColumn) {
    const value = row[columnIndex] ?? "";
    if (target.fieldKey) cells[target.fieldKey] = value;
    else if (target.custom) extras[target.custom] = value;
  }
  return { cells, extras };
}

// ── Identity matching ──────────────────────────────────────────────────────

/**
 * One row's identity keys, best first.
 *
 * A tuple only produces a key when EVERY field in it has a value: half a
 * name pair identifies nobody, and treating it as a match would merge
 * two people.
 */
export function identityKeys(
  values: ImportRowValues,
  matchBy: readonly (readonly string[])[],
): string[] {
  const keys: string[] = [];
  matchBy.forEach((tuple, tupleIndex) => {
    const parts: string[] = [];
    for (const field of tuple) {
      const token = identityToken(values[field]);
      if (!token) return;
      parts.push(token);
    }
    keys.push(`${tupleIndex} ${parts.join(" ")}`);
  });
  return keys;
}

/**
 * How two values are compared for identity: case-folded, whitespace
 * collapsed, nothing else. `Ana Ruiz ` and `ana  ruiz` are the same
 * person; `A. Ruiz` is not, and pretending otherwise would merge records
 * on a guess.
 */
export function identityToken(value: ImportValue | undefined): string {
  if (value === null || value === undefined) return "";
  return String(value).trim().replace(/\s+/g, " ").toLowerCase();
}

export interface IdentityIndex {
  lookup(values: ImportRowValues): string | null;
}

/** Index existing records by every matchBy tuple, best tuple first. */
export function buildIdentityIndex(
  existing: readonly ExistingRecord[],
  matchBy: readonly (readonly string[])[],
): IdentityIndex {
  const index = new Map<string, string>();
  for (const record of existing) {
    for (const key of identityKeys(record.values, matchBy)) {
      // First writer wins. Two existing records answering to one key is
      // pre-existing duplication in the app's own table; picking the
      // earlier one keeps a re-import stable run to run instead of
      // flip-flopping between them.
      if (!index.has(key)) index.set(key, record.id);
    }
  }

  return {
    lookup(values) {
      for (const key of identityKeys(values, matchBy)) {
        const hit = index.get(key);
        if (hit) return hit;
      }
      return null;
    },
  };
}
