/**
 * Uploads store -- server-mirroring state for the file paved road.
 *
 * Three surfaces read from here:
 *   - <UploadField> reads the upload POLICY and posts files
 *   - the review queue page reads the QUEUE and posts decisions
 *   - any page that lists attachments reads a subject-scoped LIST
 *
 * The policy is fetched rather than hardcoded. `$lib/upload-types` holds
 * a mirror of the server's allowlist so the picker has an `accept`
 * attribute on first paint, but the moment the real policy arrives it
 * wins. The server is the only thing that decides what it will accept.
 */

import { createQuery, invalidateQueries, type Query } from "../lib/query.svelte";
import { api, ApiError, extractErrorMessage } from "../lib/api";
import {
  acceptAttribute,
  MAX_UPLOAD_BYTES,
  UPLOAD_TYPE_IDS,
  UPLOAD_TYPES,
  type UploadTypeId,
} from "../lib/upload-types";

// -- Types (mirror the API payloads) --

export type UploadedFileStatus = "pending_review" | "approved" | "rejected";

export interface UploadedFileSummary {
  id: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  status: UploadedFileStatus;
  subjectType: string | null;
  subjectId: string | null;
  uploadedBy: string | null;
  reviewReason: string | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
  createdAt: string;
}

export interface UploadPolicyType {
  id: UploadTypeId;
  label: string;
  extensions: string[];
  contentTypes: string[];
}

export interface UploadPolicy {
  maxBytes: number;
  accept: string;
  types: UploadPolicyType[];
}

interface PolicyResponse {
  data: UploadPolicy;
}

interface ListResponse {
  data: UploadedFileSummary[];
}

interface QueueResponse {
  data: { files: UploadedFileSummary[]; pendingCount: number };
}

/** The pre-fetch fallback, built from the client mirror of the allowlist. */
export const FALLBACK_UPLOAD_POLICY: UploadPolicy = {
  maxBytes: MAX_UPLOAD_BYTES,
  accept: acceptAttribute(),
  types: UPLOAD_TYPE_IDS.map((id) => ({
    id,
    label: UPLOAD_TYPES[id].label,
    extensions: [...UPLOAD_TYPES[id].extensions],
    contentTypes: [...UPLOAD_TYPES[id].contentTypes],
  })),
};

// -- Queries --

/**
 * What the server will accept. Long stale time: this changes when the
 * app is redeployed, not while somebody is looking at a form.
 */
export function getUploadPolicyQuery(): Query<PolicyResponse> {
  return createQuery<PolicyResponse>({
    key: "uploads:policy",
    fetcher: () => api.get<PolicyResponse>("/files/upload-policy"),
    staleTime: 10 * 60_000,
  });
}

/** Files attached to one record, or the whole workspace when unscoped. */
export function getUploadsQuery(
  opts: { subjectType?: string; subjectId?: string; status?: UploadedFileStatus } = {},
): Query<ListResponse> {
  const params = new URLSearchParams();
  if (opts.subjectType) params.set("subjectType", opts.subjectType);
  if (opts.subjectId) params.set("subjectId", opts.subjectId);
  if (opts.status) params.set("status", opts.status);
  const suffix = params.toString();

  return createQuery<ListResponse>({
    key: `uploads:list:${suffix || "all"}`,
    fetcher: () => api.get<ListResponse>(`/files/uploads${suffix ? `?${suffix}` : ""}`),
    staleTime: 15_000,
  });
}

/** The admin review queue. Requires the files.review capability. */
export function getReviewQueueQuery(): Query<QueueResponse> {
  return createQuery<QueueResponse>({
    key: "uploads:review-queue",
    fetcher: () => api.get<QueueResponse>("/files/review-queue"),
    staleTime: 15_000,
    // A queue somebody is working should not go stale behind them while
    // a colleague clears items from another tab.
    refetchInterval: 60_000,
  });
}

// -- Uploading --

export interface UploadOptions {
  file: File;
  subjectType?: string | null;
  subjectId?: string | null;
  /** 0 to 1. Called as the bytes go out. */
  onProgress?: (fraction: number) => void;
}

/**
 * POST one file.
 *
 * XMLHttpRequest rather than fetch, for one reason: fetch cannot report
 * upload progress. A progress bar on a 15 MB scan over a hotel wifi is
 * the difference between "it is working" and "it is broken".
 */
export function uploadFile(opts: UploadOptions): Promise<UploadedFileSummary> {
  const form = new FormData();
  form.set("file", opts.file);
  if (opts.subjectType) form.set("subjectType", opts.subjectType);
  if (opts.subjectId) form.set("subjectId", opts.subjectId);

  return new Promise<UploadedFileSummary>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/files/uploads");
    // Same-origin, so the session cookie rides along by default. Set
    // explicitly anyway, because a customer app that moves the API to
    // another host would otherwise lose the session silently.
    xhr.withCredentials = true;

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) {
        opts.onProgress?.(event.loaded / event.total);
      }
    };

    xhr.onload = () => {
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(xhr.responseText);
      } catch {
        parsed = null;
      }

      if (xhr.status >= 200 && xhr.status < 300) {
        const file = (parsed as { data?: UploadedFileSummary } | null)?.data;
        if (!file) {
          reject(new ApiError(xhr.status, "The server accepted the file but returned nothing."));
          return;
        }
        opts.onProgress?.(1);
        resolve(file);
        return;
      }

      // Surface the SERVER's message. It names the actual problem, which
      // for an upload is nearly always something the person can fix
      // ("logo.png is not an accepted file type").
      reject(
        new ApiError(
          xhr.status,
          extractErrorMessage(parsed) ?? `The upload failed (${xhr.status}).`,
          parsed,
        ),
      );
    };

    xhr.onerror = () => {
      reject(new ApiError(0, "The upload could not reach the server."));
    };
    xhr.onabort = () => {
      reject(new ApiError(0, "The upload was cancelled."));
    };

    xhr.send(form);
  });
}

// -- Store facade --

export const uploadsStore = {
  getPolicyQuery: getUploadPolicyQuery,
  getListQuery: getUploadsQuery,
  getReviewQueueQuery,
  upload: uploadFile,

  async approve(id: string): Promise<UploadedFileSummary> {
    const res = await api.post<{ data: UploadedFileSummary }>(
      `/files/uploads/${encodeURIComponent(id)}/approve`,
    );
    invalidateQueries("uploads:");
    return res.data;
  },

  async reject(id: string, reason: string): Promise<UploadedFileSummary> {
    const res = await api.post<{ data: UploadedFileSummary }>(
      `/files/uploads/${encodeURIComponent(id)}/reject`,
      { reason },
    );
    invalidateQueries("uploads:");
    return res.data;
  },

  async remove(id: string): Promise<void> {
    await api.delete(`/files/uploads/${encodeURIComponent(id)}`);
    invalidateQueries("uploads:");
  },

  /** A fresh signed URL. They expire, so fetch one per click. */
  async downloadUrl(id: string, opts: { forceDownload?: boolean } = {}): Promise<string> {
    const res = await api.get<{ data: { downloadUrl: string } }>(
      `/files/uploads/${encodeURIComponent(id)}/download-url${
        opts.forceDownload ? "?download=true" : ""
      }`,
    );
    return res.data.downloadUrl;
  },

  refresh(): void {
    invalidateQueries("uploads:");
  },
};

// -- Formatting helpers shared by the upload surfaces --

export function formatFileSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} bytes`;
}

export const UPLOAD_STATUS_LABELS: Record<UploadedFileStatus, string> = {
  pending_review: "Pending review",
  approved: "Approved",
  rejected: "Rejected",
};

export function uploadStatusBadgeClass(status: UploadedFileStatus): string {
  if (status === "approved") return "badge-good";
  if (status === "rejected") return "badge-bad";
  return "badge-warn";
}
