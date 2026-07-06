/**
 * Inbound Email store -- server-mirroring state for the ops monitoring
 * surface at #/inbound-emails.
 *
 * List data goes through `createQuery` (one cache entry per active status
 * filter, background-refreshed every 60s since this is an ops surface).
 * The detail read is a plain one-off fetch -- same pattern the billing
 * store uses for one-off reads -- so the page can branch on ApiError 404
 * for the friendly not-found state.
 */

import { createQuery, invalidateQueries, type Query } from "../lib/query.svelte";
import { api } from "../lib/api";
import type { InboundEmailStatus } from "../lib/inbound-emails";

// -- Types (mirror the API payloads) --

export interface InboundEmailListItem {
  id: string;
  fromAddress: string;
  toAddress: string;
  subject: string;
  status: InboundEmailStatus;
  statusReason: string | null;
  attachmentCount: number;
  receivedAt: string;
  processedAt: string | null;
}

export interface InboundEmailApplyResult {
  applied: number;
  deferred: number;
  failed: number;
  summary: string;
}

export interface InboundEmailDetail extends InboundEmailListItem {
  bodyText: string | null;
  bodyHtml: string | null;
  headers: Record<string, unknown> | null;
  applyResult: InboundEmailApplyResult | null;
  rawMimeUrl: string | null;
}

export interface InboundEmailAttachment {
  id: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  stored: boolean;
  downloadUrl: string | null;
}

/** The list filter: "all" or a single status. */
export type InboundEmailFilter = "all" | InboundEmailStatus;

interface ListResponse {
  data: { emails: InboundEmailListItem[] };
}

interface DetailResponse {
  data: { email: InboundEmailDetail; attachments: InboundEmailAttachment[] };
}

// -- Queries --

/**
 * List query, keyed by the active status filter. `createQuery` is
 * idempotent per key, so calling this from a component on every filter
 * change is safe -- each filter gets its own cache entry.
 */
export function getInboundEmailsQuery(filter: InboundEmailFilter): Query<ListResponse> {
  const statusParam = filter === "all" ? "" : `status=${encodeURIComponent(filter)}&`;
  return createQuery<ListResponse>({
    key: `inbound-emails:list:${filter}`,
    fetcher: () => api.get<ListResponse>(`/inbound-emails?${statusParam}limit=100`),
    staleTime: 30_000,
    // Ops monitoring surface -- keep it fresh in the background.
    refetchInterval: 60_000,
  });
}

// -- One-off reads --

/**
 * Fetch one email's detail + attachments. Plain fetch (not a query) so the
 * caller can catch ApiError and branch on `.status === 404` for unknown /
 * foreign ids.
 */
export async function fetchInboundEmailDetail(
  id: string,
): Promise<{ email: InboundEmailDetail; attachments: InboundEmailAttachment[] }> {
  const res = await api.get<DetailResponse>(
    `/inbound-emails/${encodeURIComponent(id)}`,
  );
  return res.data;
}

// -- Store facade --

export const inboundEmailsStore = {
  getListQuery: getInboundEmailsQuery,
  fetchDetail: fetchInboundEmailDetail,

  refresh(): void {
    invalidateQueries("inbound-emails:");
  },
};
