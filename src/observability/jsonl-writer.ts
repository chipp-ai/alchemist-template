/**
 * Append-only JSONL writer for the unified observability stream.
 *
 * File location: `<workspace>/.scratch/logs/observability.jsonl`
 *
 * The file is the single context ball that an AI agent (e.g. the
 * Alchemist Local Dev window's orchestrator) consults after a user
 * test session. Server-side log events, HTTP request records, and
 * client breadcrumbs ALL converge here in time order. Format is
 * standard JSONL — one JSON object per line, append-only.
 *
 * Rotation: at 10 MB the active file is renamed to
 *   observability.<unix-ms>.jsonl
 * and a fresh empty file is started. Keeps long dev sessions from
 * bloating the workspace AND gives the agent a clean "most recent
 * session" file to read.
 *
 * Concurrency: a single process writes (Deno) — synchronous append
 * is fine for dev volume. Errors are swallowed; observability must
 * NEVER block or break the app it's instrumenting.
 *
 * Production: this module is no-op'd when NODE_ENV === "production"
 * (the recordObsEvent caller checks ENV). When the analytics product
 * ships, the same call sites will route to a remote ingest instead.
 */

const LOG_PATH = ".scratch/logs/observability.jsonl";
const ROTATION_THRESHOLD_BYTES = 10 * 1024 * 1024; // 10 MB

let initialized = false;
/** Set true on first permission-denied-style error (typical case: `deno
 *  task db:migrate` / CI's `deno test` run without --allow-write).
 *  Subsequent appendLineSync calls become a no-op so we don't pay a
 *  thrown-and-caught exception on every log emit during scripts/CI runs
 *  that don't grant write.
 *
 *  Deno 2 throws `Deno.errors.NotCapable` (not `PermissionDenied`) when a
 *  permission was simply never granted (as opposed to interactively
 *  denied) -- both must be latched off here, or every single log emit in
 *  a no-write context re-throws-and-catches indefinitely instead of
 *  going silent after the first hit. */
function isPermissionUnavailable(e: unknown): boolean {
  return e instanceof Deno.errors.PermissionDenied || e instanceof Deno.errors.NotCapable;
}
let writeDisabled = false;

function ensureDirSync(): void {
  try {
    Deno.mkdirSync(".scratch/logs", { recursive: true });
  } catch (e) {
    if (e instanceof Deno.errors.AlreadyExists) return;
    if (isPermissionUnavailable(e)) {
      // Migration / one-shot script context: writes aren't granted.
      // Latch off so subsequent emits don't keep throwing.
      writeDisabled = true;
      return;
    }
    // Other errors (disk full, etc.) — log once to stderr and keep
    // trying on subsequent calls; transient FS issues might resolve.
    console.warn("[observability] failed to ensure log dir:", e);
  }
}

function maybeRotateSync(): void {
  try {
    const stat = Deno.statSync(LOG_PATH);
    if (stat.size < ROTATION_THRESHOLD_BYTES) return;
    const ts = Date.now();
    Deno.renameSync(LOG_PATH, `.scratch/logs/observability.${ts}.jsonl`);
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return; // first write — fine
    // Other errors: leave the existing file alone. We'd rather keep
    // appending to an oversized file than lose events trying to fix it.
    console.warn("[observability] rotation check failed:", e);
  }
}

/**
 * Append a single JSON-serialized line to the observability file.
 * Synchronous + best-effort: never throws. The caller's hot path
 * (logger emit, request middleware, breadcrumb POST) doesn't pay
 * for filesystem async, and a swallowed error here can never break
 * the user's app.
 */
export function appendLineSync(line: string): void {
  if (!initialized) {
    ensureDirSync();
    initialized = true;
  }
  if (writeDisabled) return;
  maybeRotateSync();
  try {
    Deno.writeTextFileSync(LOG_PATH, line + "\n", { append: true });
  } catch (e) {
    if (e instanceof Deno.errors.PermissionDenied) {
      writeDisabled = true;
      return;
    }
    console.warn("[observability] write failed:", e);
  }
}
