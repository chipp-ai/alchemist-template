/**
 * Dev mailbox -- the in-memory capture seam for outbound email.
 *
 * Every send that reaches `sendEmail()` is copied here when capture is
 * on (SMTP unconfigured, or the dev surface / the test runner is
 * active). Two jobs:
 *
 *   1. Local + sandbox verification. Before this existed, the only way
 *      to observe a sent email was to screen-scrape the console fallback,
 *      which no test can assert on reliably. `GET /api/dev/mailbox`
 *      turns "did that flow send the right mail" into a normal HTTP read.
 *   2. The assertion seam for tests. Tests trigger a flow and read
 *      `listCapturedEmails()`. NEVER assert on console output.
 *
 * Bounded ring buffer: the newest MAX_CAPTURED entries survive, older
 * ones drop. A long-running dev pod can send thousands of mails; an
 * unbounded array would be a slow memory leak in the one process type
 * (dev) where nobody is watching for one.
 *
 * In-memory ONLY, and deliberately so. This is a single-pod dev
 * affordance, not a delivery log: a customer app that needs a durable
 * record of what it sent should write its own table.
 */

/** Newest-N cap on the ring buffer. */
export const MAX_CAPTURED_EMAILS = 200;

export interface CapturedEmail {
  /** Monotonic per-process id. Lets a caller poll for "anything newer than X". */
  seq: number;
  /** Registered email kind ("otp", "invite", ...), or null for an ad-hoc send. */
  kind: string | null;
  to: string;
  from: string;
  subject: string;
  text: string;
  html: string | null;
  sentAt: string;
}

const buffer: CapturedEmail[] = [];
let seqCounter = 0;

/**
 * Record one sent email. Called from the transport AFTER every
 * suppression check has passed, so the mailbox reflects what was
 * actually sent -- a suppressed message is absent, which is exactly the
 * assertion a gate test needs.
 */
export function captureEmail(entry: Omit<CapturedEmail, "seq" | "sentAt">): CapturedEmail {
  seqCounter++;
  const captured: CapturedEmail = {
    seq: seqCounter,
    sentAt: new Date().toISOString(),
    ...entry,
  };
  buffer.push(captured);
  if (buffer.length > MAX_CAPTURED_EMAILS) {
    buffer.splice(0, buffer.length - MAX_CAPTURED_EMAILS);
  }
  return captured;
}

/**
 * Captured emails, newest LAST (send order). Returns a copy, so a caller
 * iterating the result can't be surprised by a concurrent send.
 *
 * @param opts.kind  only this registered kind
 * @param opts.to    only this recipient (case-insensitive)
 * @param opts.since only entries with `seq` greater than this
 */
export function listCapturedEmails(opts: {
  kind?: string;
  to?: string;
  since?: number;
} = {}): CapturedEmail[] {
  const to = opts.to?.toLowerCase();
  return buffer.filter((e) =>
    (opts.kind === undefined || e.kind === opts.kind) &&
    (to === undefined || e.to.toLowerCase() === to) &&
    (opts.since === undefined || e.seq > opts.since)
  );
}

/** The most recent captured email matching the filter, or null. */
export function lastCapturedEmail(
  opts: { kind?: string; to?: string } = {},
): CapturedEmail | null {
  const matches = listCapturedEmails(opts);
  return matches.length > 0 ? matches[matches.length - 1] : null;
}

/** Drop every captured email. Returns how many were removed. */
export function clearCapturedEmails(): number {
  const removed = buffer.length;
  buffer.length = 0;
  return removed;
}

/** Current buffer size. Cheap enough to call in a loop. */
export function capturedEmailCount(): number {
  return buffer.length;
}
