/**
 * The project's documents and files for the MCP server
 * (src/mcp/tools/project_files.ts).
 *
 * Every stored file has an `uploaded_files` row: uploads, imports, and the
 * files the app generates (PDFs, CSV exports, reports), because the files
 * convention stores generated artifacts the same way (docs/conventions/files.md).
 * Visibility is the app's own rule (`listVisibleUploadedFiles`,
 * `canReadUploadedFile`): approved files, plus the caller's own uploads,
 * plus everything for a reviewer. Every query carries the caller's org.
 *
 * Reading a file returns its text when the type is text-like and it is
 * small enough, base64 for a small binary when asked, and always a
 * short-lived signed download URL that forces a download (never inline).
 */

import {
  assertCanReadUploadedFile,
  getUploadedFile,
  listVisibleUploadedFiles,
  type UploadedFile,
  uploadedFileDownloadUrl,
} from "@/services/uploaded-file.service.ts";
import { getObject } from "@/services/storage.service.ts";

export const DOWNLOAD_URL_TTL_SECONDS = 600;
/** Text files larger than this are not inlined. */
export const MAX_INLINE_TEXT_BYTES = 1024 * 1024;
/** Characters of text returned at most. */
export const MAX_TEXT_CHARS = 200_000;
/** Binaries up to this size can come back as base64. */
export const MAX_BASE64_BYTES = 256 * 1024;

const TEXT_TYPES = [
  /^text\//,
  /^application\/(json|xml|csv|x-ndjson|yaml|x-yaml|javascript|sql|markdown)\b/,
  /\+(json|xml)\b/,
];

/** Base64 without spreading a large array onto the call stack. */
function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

export function isTextLike(contentType: string): boolean {
  const t = contentType.toLowerCase();
  return TEXT_TYPES.some((re) => re.test(t));
}

export interface DocumentSummary {
  id: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  status: string;
  subjectType: string | null;
  subjectId: string | null;
  createdAt: string;
}

function summary(f: UploadedFile): DocumentSummary {
  return {
    id: f.id,
    filename: f.filename,
    contentType: f.contentType,
    sizeBytes: f.sizeBytes,
    status: f.status,
    subjectType: f.subjectType,
    subjectId: f.subjectId,
    createdAt: f.createdAt.toISOString(),
  };
}

/** An absolute URL: the local storage driver signs a root-relative path. */
export function absoluteUrl(url: string, baseUrl: string | null): string {
  if (/^https?:\/\//i.test(url) || !baseUrl) return url;
  return `${baseUrl.replace(/\/$/, "")}${url.startsWith("/") ? "" : "/"}${url}`;
}

export async function listDocuments(opts: {
  organizationId: string;
  viewer: { id: string; role: string };
  query?: string;
  contentType?: string;
  subjectType?: string;
  subjectId?: string;
  limit?: number;
}): Promise<DocumentSummary[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  // Fetch a wider page when filtering by name or type in memory.
  const filtering = Boolean(opts.query || opts.contentType);
  const files = await listVisibleUploadedFiles({
    organizationId: opts.organizationId,
    viewer: opts.viewer,
    subjectType: opts.subjectType,
    subjectId: opts.subjectId,
    limit: filtering ? 500 : limit,
  });
  const q = opts.query?.toLowerCase();
  const ct = opts.contentType?.toLowerCase();
  return files
    .filter((f) => !q || f.filename.toLowerCase().includes(q))
    .filter((f) => !ct || f.contentType.toLowerCase().startsWith(ct))
    .slice(0, limit)
    .map(summary);
}

export interface DocumentContent {
  file: DocumentSummary;
  downloadUrl: string;
  downloadUrlExpiresInSeconds: number;
  text?: string;
  textTruncated?: boolean;
  base64?: string;
  note?: string;
}

export async function readDocument(opts: {
  id: string;
  organizationId: string;
  viewer: { id: string; role: string };
  baseUrl: string | null;
  includeBase64?: boolean;
}): Promise<DocumentContent> {
  // Org-scoped in the WHERE clause: another org's id is "not found".
  const file = await getUploadedFile({ id: opts.id, organizationId: opts.organizationId });
  assertCanReadUploadedFile(file, opts.viewer);

  const out: DocumentContent = {
    file: summary(file),
    downloadUrl: absoluteUrl(
      uploadedFileDownloadUrl(file, {
        expiresInSeconds: DOWNLOAD_URL_TTL_SECONDS,
        forceDownload: true,
      }),
      opts.baseUrl,
    ),
    downloadUrlExpiresInSeconds: DOWNLOAD_URL_TTL_SECONDS,
  };

  if (isTextLike(file.contentType)) {
    if (file.sizeBytes > MAX_INLINE_TEXT_BYTES) {
      out.note = "The file is too large to inline. Use the download URL.";
      return out;
    }
    const { body } = await getObject(file.storageKey);
    const text = new TextDecoder().decode(body);
    out.text = text.length > MAX_TEXT_CHARS ? text.slice(0, MAX_TEXT_CHARS) : text;
    out.textTruncated = text.length > MAX_TEXT_CHARS;
    return out;
  }

  if (opts.includeBase64) {
    if (file.sizeBytes > MAX_BASE64_BYTES) {
      out.note = `The file is larger than ${MAX_BASE64_BYTES} bytes. Use the download URL.`;
      return out;
    }
    const { body } = await getObject(file.storageKey);
    out.base64 = encodeBase64(body);
    return out;
  }

  out.note = "Binary file (for example a PDF or an image). Use the download URL, " +
    "or call again with includeBase64 for a small file.";
  return out;
}
