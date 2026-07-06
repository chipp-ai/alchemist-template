/**
 * Pure presentation helpers for the Inbound Email dashboard pages.
 *
 * Kept dependency-free and side-effect-free: status -> badge mapping,
 * byte formatting, date formatting, and the security-critical
 * `frameSrcdocForEmailHtml()` wrapper for rendering untrusted email HTML.
 *
 * Mirrors the inbound-email status values in the API contract
 * (GET /api/inbound-emails). Keep in sync with the backend.
 */

export type InboundEmailStatus =
  | "received"
  | "extracted"
  | "human_message"
  | "unclear"
  | "failed";

export const INBOUND_EMAIL_STATUSES: readonly InboundEmailStatus[] = [
  "received",
  "extracted",
  "human_message",
  "unclear",
  "failed",
] as const;

export interface StatusMeta {
  /** Human-readable badge label. */
  label: string;
  /** CSS badge modifier class -- distinct color per status (defined in the pages). */
  badge: string;
  /** One-line description shown as a tooltip / filter hint. */
  description: string;
}

/**
 * Status -> presentation metadata. Each status gets a DISTINCT badge color
 * so an operator can scan the list by color:
 *   received      -> neutral (gray)  -- captured, processing pending
 *   extracted     -> good (green)    -- processed successfully
 *   human_message -> info (blue)     -- a person emailed the ingestion address
 *   unclear       -> warn (amber)    -- looked like data, couldn't be parsed
 *   failed        -> bad (red)       -- processing errored
 */
export const STATUS_META: Record<InboundEmailStatus, StatusMeta> = {
  received: {
    label: "Received",
    badge: "badge-neutral",
    description: "Captured; processing pending",
  },
  extracted: {
    label: "Extracted",
    badge: "badge-good",
    description: "Processed successfully",
  },
  human_message: {
    label: "Human message",
    badge: "badge-info",
    description: "A person emailed the ingestion address",
  },
  unclear: {
    label: "Unclear",
    badge: "badge-warn",
    description: "Looked like data but could not be parsed",
  },
  failed: {
    label: "Failed",
    badge: "badge-bad",
    description: "Processing errored",
  },
};

export function isInboundEmailStatus(s: string): s is InboundEmailStatus {
  return (INBOUND_EMAIL_STATUSES as readonly string[]).includes(s);
}

/** CSS badge modifier class for a status (neutral for an unknown value). */
export function statusBadgeClass(status: string | null | undefined): string {
  if (status && isInboundEmailStatus(status)) return STATUS_META[status].badge;
  return "badge-neutral";
}

/** Human-readable label for a status (passes through unknown values). */
export function statusLabel(status: string | null | undefined): string {
  if (status && isInboundEmailStatus(status)) return STATUS_META[status].label;
  return status ?? "--";
}

/**
 * Compact relative time ("just now" / "5m ago" / "3d ago"). `now` is
 * injectable for deterministic tests; defaults to Date.now().
 */
export function relativeTime(
  value: string | number | null | undefined,
  now: number = Date.now(),
): string {
  if (value === null || value === undefined) return "--";
  const ms = typeof value === "number" ? value : Date.parse(value);
  if (!Number.isFinite(ms)) return "--";
  const diff = Math.max(0, now - ms);
  if (diff < 5_000) return "just now";
  if (diff < 60_000) return `${Math.floor(diff / 1_000)}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

/** Absolute local date-time ("6/12/2026, 3:41:07 PM"). Null/invalid -> "--". */
export function formatDateTime(value: string | null | undefined): string {
  if (!value) return "--";
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return value;
  return new Date(ms).toLocaleString();
}

/** Human-readable byte size ("1.2 KB", "3.4 MB"). Null/invalid -> "--". */
export function formatBytes(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n) || n < 0) return "--";
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = n / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toFixed(value >= 10 || value % 1 === 0 ? 0 : 1)} ${units[i]}`;
}

/**
 * Wrap untrusted email HTML for rendering inside the sandboxed body iframe.
 *
 * The iframe already carries `sandbox=""` (no scripts, no same-origin access,
 * no forms, no top-navigation), which fully neutralizes JS-based XSS and
 * session/credential theft. But an empty sandbox does NOT stop the email's own
 * SUB-RESOURCES from loading: a `<img src="https://evil/pixel">` tracking
 * beacon (or a CSS `url()` / `@font-face` / `@import` pointing at an attacker
 * host) still fires from the operator's browser the instant they open a
 * malicious forwarded email -- leaking "opened + when + IP/UA" to the sender
 * and acting as an external side channel.
 *
 * Prepend a restrictive Content-Security-Policy <meta> so the framed document
 * blocks every remote load:
 *   - default-src 'none'        -> nothing loads unless explicitly allowed
 *   - img-src data:             -> inline (data:) images only; remote pixels blocked
 *   - style-src 'unsafe-inline' -> keep inline styling so the body still reads
 *   - font-src data:            -> embedded fonts only; remote font beacons blocked
 *   - base-uri / form-action 'none' -> no <base> hijack, no form posts
 *
 * The meta sits in <head>, parsed BEFORE any untrusted body content, so it
 * governs all sub-resource fetches. CSP policies COMBINE most-restrictively, so
 * even if the email ships its own looser CSP meta, ours still applies. The
 * untrusted markup is embedded verbatim in <body> -- the sandbox + CSP make it
 * inert; we never {@html} it into the main app document.
 */
export function frameSrcdocForEmailHtml(html: string | null | undefined): string {
  const csp = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; " +
    "font-src data:; base-uri 'none'; form-action 'none'";
  return '<!DOCTYPE html><html><head><meta charset="utf-8">' +
    `<meta http-equiv="Content-Security-Policy" content="${csp}">` +
    `</head><body>${html ?? ""}</body></html>`;
}
