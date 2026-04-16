/**
 * Shared zValidator hook for Hono routes.
 *
 * The default @hono/zod-validator hook returns `{ success: false, error: ZodError }`
 * where `error` is a serialized ZodError object. Clients that do `data.error` get
 * `[object Object]` instead of a readable message. This hook extracts the first
 * human-readable issue message and returns `{ error: string }`.
 */

import type { Context } from "hono";
import type { ZodError } from "zod";

/**
 * Hook for zValidator that returns human-readable error strings.
 * Pass as the third argument to zValidator:
 *
 *   zValidator("json", schema, validationHook)
 */
export function validationHook(
  result: { success: boolean; error?: ZodError },
  c: Context,
) {
  if (!result.success) {
    const firstIssue = result.error?.issues?.[0];
    const message = firstIssue?.message || "Invalid request data";
    return c.json({ error: message }, 400);
  }
}
