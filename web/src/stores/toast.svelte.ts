/**
 * Toast store — transient, auto-dismissing notifications.
 *
 * Built on `defineStore` (see web/src/lib/devpanel/store.svelte.ts) so the
 * DevPanel + `/api/dev/app-state` can introspect the current toast queue
 * like every other piece of shared state.
 *
 * Usage (from anywhere — a route, a store action, an error handler):
 *   import { toastStore } from "../stores/toast.svelte";
 *   toastStore.show("Invite sent", "success");
 *   toastStore.show("Could not save changes", "error", { durationMs: 8000 });
 *
 * Rendering: <ToastContainer /> (mounted once in App.svelte) reads
 * `toastStore.toasts` and renders + auto-dismisses each entry. Callers never
 * touch the DOM directly — this module is the entire public surface.
 */
import { defineStore } from "../lib/devpanel/store.svelte";

export type ToastVariant = "info" | "success" | "warning" | "error";

export interface ToastItem {
  id: string;
  message: string;
  variant: ToastVariant;
  /** ms before auto-dismiss. 0 = stays until manually dismissed. */
  durationMs: number;
}

interface ToastState {
  toasts: ToastItem[];
}

const state = defineStore<ToastState>("toast", {
  toasts: [],
});

const DEFAULT_DURATION_MS = 5000;

// Auto-dismiss timers, keyed by toast id — kept outside reactive state
// (timer handles aren't snapshot/JSON-safe).
const timers = new Map<string, ReturnType<typeof setTimeout>>();

function dismiss(id: string): void {
  const timer = timers.get(id);
  if (timer !== undefined) {
    clearTimeout(timer);
    timers.delete(id);
  }
  // Top-level array replacement — see CLAUDE.md "Stores and the DevPanel".
  state.toasts = state.toasts.filter((t) => t.id !== id);
}

function show(
  message: string,
  variant: ToastVariant = "info",
  opts: { durationMs?: number } = {},
): string {
  const id = crypto.randomUUID();
  const durationMs = opts.durationMs ?? DEFAULT_DURATION_MS;

  state.toasts = [...state.toasts, { id, message, variant, durationMs }];

  if (durationMs > 0) {
    timers.set(
      id,
      setTimeout(() => dismiss(id), durationMs),
    );
  }

  return id;
}

function clear(): void {
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
  state.toasts = [];
}

export const toastStore = {
  get toasts() {
    return state.toasts;
  },
  show,
  dismiss,
  clear,
  /** Convenience wrappers for the common variants. */
  info: (message: string, opts?: { durationMs?: number }) => show(message, "info", opts),
  success: (message: string, opts?: { durationMs?: number }) => show(message, "success", opts),
  warning: (message: string, opts?: { durationMs?: number }) => show(message, "warning", opts),
  error: (message: string, opts?: { durationMs?: number }) => show(message, "error", opts),
};
