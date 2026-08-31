/**
 * Client mirror of the server's upload allowlist.
 *
 * The server's `src/utils/upload-types.ts` is authoritative. This file
 * exists for one reason: the file picker must be able to reject an
 * obviously wrong file BEFORE it spends a round trip, and it must be able
 * to render an `accept` attribute on first paint, before any API call has
 * landed.
 *
 * Two things keep it honest:
 *
 *   1. `uploadPolicy()` (web/src/stores/uploads.svelte.ts) fetches
 *      `GET /api/files/upload-policy` and uses the SERVER's list once it
 *      arrives. This table is the pre-fetch fallback, not the rule.
 *   2. `src/__tests__/services/upload-types.test.ts` lints the two files
 *      for identical type ids, extensions, content types, and size cap.
 *      Drift fails the build, the same way lib/roles.ts and
 *      lib/permissions.ts are kept in step.
 *
 * A client-side check is a courtesy, never a control. The server refuses
 * the same file again with the same rules.
 */

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
  label: string;
  extensions: readonly string[];
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

export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024; // 20 MB

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
  extension: string;
  contentType: string;
}

export interface UploadCheckFailure {
  ok: false;
  code: UploadRejectionCode;
  message: string;
}

export type UploadCheckResult = UploadCheckOk | UploadCheckFailure;

export interface UploadCheckOptions {
  allow?: readonly UploadTypeId[];
  maxBytes?: number;
}

export interface UploadCandidate {
  filename: string;
  contentType: string;
  sizeBytes?: number;
}

export function extensionOf(filename: string): string {
  const base = filename.trim().split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) return "";
  return base.slice(dot).toLowerCase();
}

export function normalizeContentType(contentType: string): string {
  return contentType.split(";")[0].trim().toLowerCase();
}

function allowedTypes(allow?: readonly UploadTypeId[]): UploadTypeSpec[] {
  if (!allow) return UPLOAD_TYPE_IDS.map((id) => UPLOAD_TYPES[id]);
  return allow.filter((id) => id in UPLOAD_TYPES).map((id) => UPLOAD_TYPES[id]);
}

function typeList(types: UploadTypeSpec[]): string {
  return types.map((t) => t.extensions[0]).join(", ");
}

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
      message:
        `This file is named ${extension} but declares itself as ${contentType}. ` +
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

export function acceptAttribute(allow?: readonly UploadTypeId[]): string {
  const types = allowedTypes(allow);
  const parts: string[] = [];
  for (const t of types) {
    for (const ext of t.extensions) parts.push(ext);
    for (const ct of t.contentTypes) parts.push(ct);
  }
  return [...new Set(parts)].join(",");
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${Math.round(bytes / (1024 * 1024))} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} bytes`;
}
