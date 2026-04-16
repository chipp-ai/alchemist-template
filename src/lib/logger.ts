/**
 * Structured Logger
 *
 * Dev: human-readable color-coded output
 * Production: NDJSON (one JSON object per line) for machine parsing
 *
 * Usage:
 *   import { log } from "@/lib/logger.ts";
 *
 *   log.error("Payment failed", { source: "billing", orgId }, error);
 *   log.warn("Credits low", { source: "billing", orgId });
 *   log.info("Server started", { source: "startup", port: 8000 });
 *   log.debug("Cache hit", { source: "cache", key: "abc" });
 */

type LogLevel = "debug" | "info" | "warn" | "error";

// ── Environment (read once at module load) ──

const VERSION = (() => {
  try {
    return Deno.env.get("GIT_SHA")?.slice(0, 7) ?? "dev";
  } catch {
    return "dev";
  }
})();

const ENVIRONMENT = (() => {
  try {
    return Deno.env.get("NODE_ENV") ?? "development";
  } catch {
    return "development";
  }
})();

const IS_DEV = ENVIRONMENT === "development";

// Tenant ID — injected by the Alchemist platform at provisioning time.
// Present in all deployed customer apps; absent in local dev.
const TENANT_ID = (() => {
  try {
    return Deno.env.get("ALCHEMIST_TENANT_ID") ?? null;
  } catch {
    return null;
  }
})();

// App slug — human-readable project identifier set at provisioning time.
const APP_SLUG = (() => {
  try {
    return Deno.env.get("ALCHEMIST_APP_SLUG") ?? null;
  } catch {
    return null;
  }
})();

// ── Error serialization ──

function serializeError(error: unknown): { name: string; message: string; stack?: string } {
  if (error instanceof Error) {
    return { name: error.name, message: error.message, stack: error.stack };
  }
  return { name: "UnknownError", message: String(error) };
}

function toError(error: unknown): Error {
  if (error instanceof Error) return error;
  return new Error(String(error));
}

// ── Dev pretty-printer ──

const LEVEL_COLORS: Record<LogLevel, string> = {
  debug: "\x1b[90m", // gray
  info: "\x1b[36m", // cyan
  warn: "\x1b[33m", // yellow
  error: "\x1b[31m", // red
};
const RESET = "\x1b[0m";
const DIM = "\x1b[2m";

function prettyPrint(
  level: LogLevel,
  msg: string,
  ctx: Record<string, unknown>,
  error?: unknown,
): void {
  const color = LEVEL_COLORS[level];
  const { source, ...rest } = ctx;
  const prefix = `${color}[${level.toUpperCase()}]${RESET} ${DIM}${source ?? "app"}${RESET}`;

  const contextParts = Object.entries(rest)
    .map(([k, v]) => `${DIM}${k}=${RESET}${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join("  ");
  const contextStr = contextParts ? `\n  ${contextParts}` : "";

  const out = level === "error" || level === "warn" ? console.error : console.log;
  out(`${prefix} | ${msg}${contextStr}`);
  if (error) {
    const errObj = toError(error);
    out(`  ${errObj.stack ?? errObj.message}`);
  }
}

// ── NDJSON emitter (production) ──

function emitJson(
  level: LogLevel,
  msg: string,
  ctx: Record<string, unknown>,
  error?: unknown,
): void {
  const entry: Record<string, unknown> = {
    level,
    ts: new Date().toISOString(),
    version: VERSION,
    env: ENVIRONMENT,
    msg,
    ...(TENANT_ID && { tenant_id: TENANT_ID }),
    ...(APP_SLUG && { app_slug: APP_SLUG }),
    ...ctx,
  };

  if (error) {
    const serialized = serializeError(error);
    entry.error_message = serialized.message;
    entry.error_stack = serialized.stack;
  }

  console.log(JSON.stringify(entry));
}

// ── Core emit ──

function emit(
  level: LogLevel,
  msg: string,
  ctx: Record<string, unknown>,
  error?: unknown,
): void {
  if (IS_DEV) {
    prettyPrint(level, msg, ctx, error);
  } else {
    emitJson(level, msg, ctx, error);
  }
}

// ── Public API ──

export const log = {
  /** Log an error. Pass an Error as the 3rd arg for stack traces. */
  error(msg: string, ctx: Record<string, unknown>, error?: unknown): void {
    emit("error", msg, ctx, error);
  },

  /** Log a warning. Pass an Error as the 3rd arg for stack traces. */
  warn(msg: string, ctx: Record<string, unknown>, error?: unknown): void {
    emit("warn", msg, ctx, error);
  },

  /** Operational info. Structured in prod, no alerting. */
  info(msg: string, ctx: Record<string, unknown>): void {
    emit("info", msg, ctx);
  },

  /** Dev-only debug logging. Not emitted in production. */
  debug(msg: string, ctx: Record<string, unknown>): void {
    if (IS_DEV) {
      emit("debug", msg, ctx);
    }
  },
};
