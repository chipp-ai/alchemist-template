/**
 * Runtime errors and the Chipp Builder preview.
 *
 * While someone builds this app in Chipp, the Builder shows it in a framed
 * preview. A script the preview injects (the "preview bridge") sets
 * `window.__CHIPP_PREVIEW__` before the app loads and listens for
 * `chipp:app-error`. The Builder's dev overlay then shows the crash with
 * its stack and an "Ask the agent to fix this" button, so the app's own
 * crash screen must not compete with it:
 *
 * - The error boundary (components/AppErrorBoundary.svelte) calls
 *   reportAppError() for every error it catches.
 * - Inside the preview (isInBuilderPreview()), it renders one plain line
 *   instead of its full fallback.
 *
 * Outside the preview nothing listens to the event and the flag is unset,
 * so a deployed app behaves exactly as before. Uncaught errors and
 * unhandled rejections reach the overlay without this file: the bridge
 * listens for them itself.
 *
 * Zero dependencies, so a plain Deno test can import it.
 */

/** The window event the preview bridge forwards to the Builder. */
export const APP_ERROR_EVENT = "chipp:app-error";

/** The window property the preview bridge sets on a framed preview page. */
export const PREVIEW_FLAG = "__CHIPP_PREVIEW__";

export interface AppErrorDetail {
  message: string;
  stack?: string;
  /** A component stack, when the framework gives one. */
  componentStack?: string;
}

type WindowLike = { [key: string]: unknown; dispatchEvent?: (event: Event) => boolean };

function currentWindow(): WindowLike | null {
  return typeof globalThis === "undefined" ? null : (globalThis as unknown as WindowLike);
}

/** True when this page runs inside the Chipp Builder preview. */
export function isInBuilderPreview(win: WindowLike | null = currentWindow()): boolean {
  return !!win && !!win[PREVIEW_FLAG];
}

/** A thrown value as an AppErrorDetail ("TypeError: message", its stack). */
export function toAppErrorDetail(error: unknown): AppErrorDetail {
  if (error instanceof Error) {
    const message = !error.message
      ? error.name
      : error.message.startsWith(`${error.name}:`)
      ? error.message
      : `${error.name}: ${error.message}`;
    return { message, stack: error.stack };
  }
  if (typeof error === "string" && error) return { message: error };
  try {
    return { message: JSON.stringify(error) ?? String(error) };
  } catch {
    return { message: String(error) };
  }
}

/**
 * Tell the Builder preview the app crashed. Safe everywhere: outside the
 * preview nobody listens, and it never throws.
 */
export function reportAppError(error: unknown, win: WindowLike | null = currentWindow()): void {
  if (!win || typeof win.dispatchEvent !== "function" || typeof CustomEvent === "undefined") return;
  try {
    win.dispatchEvent(new CustomEvent(APP_ERROR_EVENT, { detail: toAppErrorDetail(error) }));
  } catch {
    // Best effort: the boundary's own fallback already shows.
  }
}
