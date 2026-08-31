/**
 * Accepted upload types -- ONE allowlist, enforced on every upload route.
 *
 * This module is the single source of truth for "what may a person
 * upload". Every server-side upload path calls `assertAllowedUpload()`;
 * the browser reads the same list over `GET /api/files/upload-policy`
 * and keeps `web/src/lib/upload-types.ts` as a pre-fetch mirror. A test
 * (`src/__tests__/services/upload-types.test.ts`) fails the build if the
 * mirror drifts from this table.
 *
 * The check is FAIL CLOSED and it looks at BOTH signals:
 *
 *   1. the file extension, and
 *   2. the declared content type,
 *
 * and then requires the two to agree. Either one alone is trivially
 * spoofed: a browser sends whatever `Content-Type` the OS guessed, and a
 * `.png` suffix says nothing about the bytes. Requiring agreement is not
 * content sniffing (we do not read the bytes), it is refusing to accept a
 * file whose own two labels contradict each other.
 *
 * Narrowing per call:
 *
 *   assertAllowedUpload(candidate, { allow: ["pdf", "png"] })
 *
 * A route that only ever wants a scanned document passes `allow`. It can
 * never WIDEN the list: `allow` intersects with this table, so a caller
 * asking for a type that is not here gets nothing.
 *
 * Adding a type is a one-line edit here plus the same line in the web
 * mirror. Do not add a second allowlist anywhere.
 */

import { BadRequestError } from "@/utils/errors.ts";

// ── The table ──────────────────────────────────────────────────────────────

export const UPLOAD_TYPE_IDS = [
  "pdf",
  "jpeg",
  "png",
  "doc",
  "docx",
  "csv",
  "xlsx",
] as const;

export type UploadTypeId = (typeof UPLOAD_TYPE_IDS)[number];

export interface UploadTypeSpec {
  id: UploadTypeId;
  /** Shown in the UI's "accepted files" hint. */
  label: string;
  /** Lowercase, dot-prefixed. The first entry is canonical. */
  extensions: readonly string[];
  /** Lowercase MIME types a browser may plausibly send. First is canonical. */
  contentTypes: readonly string[];
}

export const UPLOAD_TYPES: Record<UploadTypeId, UploadTypeSpec> = {
  pdf: {
    id: "pdf",
    label: "PDF",
    extensions: [".pdf"],
    contentTypes: ["application/pdf"],
  },
  jpeg: {
    id: "jpeg",
    label: "JPEG image",
    extensions: [".jpg", ".jpeg"],
    contentTypes: ["image/jpeg"],
  },
  png: {
    id: "png",
    label: "PNG image",
    extensions: [".png"],
    contentTypes: ["image/png"],
  },
  doc: {
    id: "doc",
    label: "Word document (legacy)",
    extensions: [".doc"],
    contentTypes: ["application/msword"],
  },
  docx: {
    id: "docx",
    label: "Word document",
    extensions: [".docx"],
    contentTypes: [
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ],
  },
  csv: {
    id: "csv",
    label: "CSV spreadsheet",
    // Windows sends application/csv and, from an Excel-associated .csv,
    // application/vnd.ms-excel. Both are the same user intent; listing
    // them explicitly is narrower than falling back to text/plain, which
    // would let a .txt rename through.
    extensions: [".csv"],
    contentTypes: ["text/csv", "application/csv", "application/vnd.ms-excel"],
  },
  xlsx: {
    id: "xlsx",
    label: "Excel spreadsheet",
    extensions: [".xlsx"],
    contentTypes: [
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ],
  },
};

/**
 * Ceiling for any upload this app accepts, in bytes.
 *
 * ONE cap, not one per route. The managed upload route buffers the whole
 * body in memory before it writes, so this is a memory bound as much as a
 * product rule; raising it raises the per-request footprint of every
 * concurrent upload. A presigned direct-to-R2 PUT cannot be size-checked
 * server-side by construction, which is the other reason to keep the
 * proxied path the default.
 */
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024; // 20 MB

// ── Checking ───────────────────────────────────────────────────────────────

export type UploadRejectionCode =
  | "missing_filename"
  | "missing_content_type"
  | "extension_not_allowed"
  | "content_type_not_allowed"
  | "type_mismatch"
  | "empty"
  | "too_large";

export interface UploadCheckOk {
  ok: true;
  type: UploadTypeSpec;
  /** The matched extension, lowercase and dot-prefixed. */
  extension: string;
  /** The declared content type, lowercased and stripped of parameters. */
  contentType: string;
}

export interface UploadCheckFailure {
  ok: false;
  code: UploadRejectionCode;
  message: string;
}

export type UploadCheckResult = UploadCheckOk | UploadCheckFailure;

export interface UploadCheckOptions {
  /** Narrow the allowlist for this call. Never widens it. */
  allow?: readonly UploadTypeId[];
  /** Lower the size cap for this call. Never raises it above MAX_UPLOAD_BYTES. */
  maxBytes?: number;
}

export interface UploadCandidate {
  filename: string;
  contentType: string;
  /** Omit when the size is not known yet (a presigned-URL request). */
  sizeBytes?: number;
}

/** Lowercase, dot-prefixed extension of a filename, or "" when it has none. */
export function extensionOf(filename: string): string {
  // Take the basename first: a caller may hand us a path, and the
  // extension of `a.pdf/evil` is not `.pdf`.
  const base = filename.trim().split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) return "";
  return base.slice(dot).toLowerCase();
}

/** Strip `; charset=...` and lowercase. */
export function normalizeContentType(contentType: string): string {
  return contentType.split(";")[0].trim().toLowerCase();
}

function allowedTypes(allow?: readonly UploadTypeId[]): UploadTypeSpec[] {
  if (!allow) return UPLOAD_TYPE_IDS.map((id) => UPLOAD_TYPES[id]);
  // Intersect, never union: an id that is not in the table is dropped, so
  // `allow` can only ever narrow.
  return allow.filter((id) => id in UPLOAD_TYPES).map((id) => UPLOAD_TYPES[id]);
}

function typeList(types: UploadTypeSpec[]): string {
  return types.map((t) => t.extensions[0]).join(", ");
}

/**
 * Pure predicate. Returns a result rather than throwing, so a UI can use
 * the same shape as the server. `assertAllowedUpload` is the throwing
 * wrapper the routes use.
 */
export function checkUpload(
  candidate: UploadCandidate,
  options: UploadCheckOptions = {},
): UploadCheckResult {
  const types = allowedTypes(options.allow);
  const maxBytes = Math.min(options.maxBytes ?? MAX_UPLOAD_BYTES, MAX_UPLOAD_BYTES);

  const filename = (candidate.filename ?? "").trim();
  if (!filename) {
    return { ok: false, code: "missing_filename", message: "The file needs a name." };
  }

  const extension = extensionOf(filename);
  const byExtension = types.find((t) => t.extensions.includes(extension));
  if (!byExtension) {
    return {
      ok: false,
      code: "extension_not_allowed",
      message: `${extension || "That file"} is not an accepted file type. Accepted: ${
        typeList(types)
      }.`,
    };
  }

  const contentType = normalizeContentType(candidate.contentType ?? "");
  if (!contentType) {
    return {
      ok: false,
      code: "missing_content_type",
      message: "The upload did not declare a content type.",
    };
  }

  const byContentType = types.find((t) => t.contentTypes.includes(contentType));
  if (!byContentType) {
    return {
      ok: false,
      code: "content_type_not_allowed",
      message: `${contentType} is not an accepted content type. Accepted: ${typeList(types)}.`,
    };
  }

  if (byExtension.id !== byContentType.id) {
    return {
      ok: false,
      code: "type_mismatch",
      message: `This file is named ${extension} but declares itself as ${contentType}. ` +
        `Rename it or re-export it, then try again.`,
    };
  }

  if (candidate.sizeBytes !== undefined) {
    if (candidate.sizeBytes <= 0) {
      return { ok: false, code: "empty", message: "That file is empty." };
    }
    if (candidate.sizeBytes > maxBytes) {
      return {
        ok: false,
        code: "too_large",
        message: `That file is larger than the ${formatBytes(maxBytes)} limit.`,
      };
    }
  }

  return { ok: true, type: byExtension, extension, contentType };
}

/**
 * Throwing wrapper for route + service code. A rejection is a 400 with a
 * message a person can act on, never a 500.
 */
export function assertAllowedUpload(
  candidate: UploadCandidate,
  options: UploadCheckOptions = {},
): UploadCheckOk {
  const result = checkUpload(candidate, options);
  if (!result.ok) throw new BadRequestError(result.message);
  return result;
}

// ── Description (what the API hands the browser) ───────────────────────────

export interface UploadPolicy {
  maxBytes: number;
  /** Ready for an `<input accept="...">` attribute. */
  accept: string;
  types: {
    id: UploadTypeId;
    label: string;
    extensions: readonly string[];
    contentTypes: readonly string[];
  }[];
}

/** The `accept` attribute for a file input: extensions plus MIME types. */
export function acceptAttribute(allow?: readonly UploadTypeId[]): string {
  const types = allowedTypes(allow);
  const parts: string[] = [];
  for (const t of types) {
    for (const ext of t.extensions) parts.push(ext);
    for (const ct of t.contentTypes) parts.push(ct);
  }
  return [...new Set(parts)].join(",");
}

export function describeUploadPolicy(options: UploadCheckOptions = {}): UploadPolicy {
  const types = allowedTypes(options.allow);
  return {
    maxBytes: Math.min(options.maxBytes ?? MAX_UPLOAD_BYTES, MAX_UPLOAD_BYTES),
    accept: acceptAttribute(options.allow),
    types: types.map((t) => ({
      id: t.id,
      label: t.label,
      extensions: t.extensions,
      contentTypes: t.contentTypes,
    })),
  };
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${Math.round(bytes / (1024 * 1024))} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} bytes`;
}
