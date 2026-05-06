/**
 * Session-timeout store.
 *
 * Implements HIPAA §164.312(a)(2)(iii) "automatic logoff" on the SPA
 * side: tracks user activity, shows a non-dismissable warning 5 min
 * before timeout, force-logs-out at the timeout boundary. Mirrors the
 * server-side TTL stamped into the JWT (`src/utils/session-duration.ts`).
 *
 * Activation contract: only initialize when `authStore.hipaaEnabled`
 * is true. On non-HIPAA deployments this store is dead code — the
 * 30-day default JWT does the absolute-expiry job alone.
 *
 * Timer model:
 *   - Each DOM activity event resets the timers (throttled to 1 / sec).
 *   - Throttled server-touch (POST /auth/touch) every 5 min during
 *     activity refreshes the JWT + cookie.
 *   - Warning modal opens at (TTL − 5 min); seconds-remaining counts
 *     down once / sec until logout.
 *   - BroadcastChannel keeps multiple tabs in sync — activity in tab A
 *     resets tab B's timers, so a logged-in user with three tabs open
 *     doesn't get warned about a "stale" one when they're actively
 *     using another.
 *
 * Init/destroy pattern follows defineStore convention so the DevPanel
 * can introspect remaining-time + warning state at runtime.
 */

import { defineStore } from "../lib/devpanel/store.svelte";
import { authStore } from "./auth.svelte";
import { api } from "../lib/api";

const WARNING_BEFORE_TIMEOUT_MS = 5 * 60 * 1000;
const TOUCH_THROTTLE_MS = 5 * 60 * 1000;
const ACTIVITY_THROTTLE_MS = 1000;
const ACTIVITY_EVENTS = [
  "mousedown",
  "keydown",
  "scroll",
  "touchstart",
  "click",
] as const;
const BROADCAST_CHANNEL = "alchemist-session-activity";

interface SessionTimeoutState {
  /** True while the warning modal is rendered. */
  showWarning: boolean;
  /** Seconds until forced logout (only meaningful when showWarning). */
  secondsRemaining: number;
  /** True between init() and destroy(). DevPanel-visible. */
  active: boolean;
}

const state = defineStore<SessionTimeoutState>("sessionTimeout", {
  showWarning: false,
  secondsRemaining: 0,
  active: false,
});

// Non-reactive state — timers + last-activity timestamps.
let warningTimer: ReturnType<typeof setTimeout> | null = null;
let logoutTimer: ReturnType<typeof setTimeout> | null = null;
let countdownInterval: ReturnType<typeof setInterval> | null = null;
let lastTouch = 0;
let lastActivityProcessed = 0;
let activityHandler: ((e: Event) => void) | null = null;
let broadcast: BroadcastChannel | null = null;

function clearAllTimers(): void {
  if (warningTimer) {
    clearTimeout(warningTimer);
    warningTimer = null;
  }
  if (logoutTimer) {
    clearTimeout(logoutTimer);
    logoutTimer = null;
  }
  if (countdownInterval) {
    clearInterval(countdownInterval);
    countdownInterval = null;
  }
}

async function touchServer(): Promise<void> {
  const now = Date.now();
  if (now - lastTouch < TOUCH_THROTTLE_MS) return;
  lastTouch = now;
  try {
    await api.post("/auth/touch", {});
  } catch {
    // Network blip — don't logout, retry on next activity.
  }
}

function forceLogout(): void {
  clearAllTimers();
  state.showWarning = false;
  state.secondsRemaining = 0;
  state.active = false;
  // Use authStore.logout — it clears the cookie server-side AND
  // pushes the SPA to /login. Avoid window.location reload races.
  authStore.logout().catch(() => {
    // Even if /auth/logout 401s (already-expired session), the local
    // store-clear + redirect inside logout() still runs.
  });
}

function startTimers(): void {
  clearAllTimers();
  state.showWarning = false;
  state.secondsRemaining = 0;

  const ttlMs = authStore.sessionDurationMs;
  const warningAtMs = ttlMs - WARNING_BEFORE_TIMEOUT_MS;

  warningTimer = setTimeout(() => {
    state.showWarning = true;
    state.secondsRemaining = Math.floor(WARNING_BEFORE_TIMEOUT_MS / 1000);
    countdownInterval = setInterval(() => {
      state.secondsRemaining = Math.max(0, state.secondsRemaining - 1);
    }, 1000);
  }, warningAtMs);

  logoutTimer = setTimeout(forceLogout, ttlMs);
}

function onActivity(): void {
  const now = Date.now();
  if (now - lastActivityProcessed < ACTIVITY_THROTTLE_MS) return;
  lastActivityProcessed = now;

  startTimers();
  // Fire-and-forget; throttle inside touchServer.
  void touchServer();
  // Tell other tabs the user is alive.
  broadcast?.postMessage({ type: "activity", at: now });
}

function onBroadcast(ev: MessageEvent): void {
  if (ev.data?.type === "activity") {
    // Another tab saw activity — restart our timers without re-firing
    // the server touch (the originating tab already did).
    startTimers();
  }
}

/**
 * Begin tracking activity + timers. Idempotent — safe to call twice.
 * Should run once after the user lands authenticated AND
 * `authStore.hipaaEnabled` is true.
 */
function init(): void {
  if (state.active) return;
  state.active = true;

  activityHandler = () => onActivity();
  for (const evt of ACTIVITY_EVENTS) {
    window.addEventListener(evt, activityHandler, { passive: true });
  }

  if (typeof BroadcastChannel !== "undefined") {
    broadcast = new BroadcastChannel(BROADCAST_CHANNEL);
    broadcast.onmessage = onBroadcast;
  }

  startTimers();
}

/** Tear down all listeners + timers. Called on logout / unmount. */
function destroy(): void {
  if (!state.active) return;
  state.active = false;

  clearAllTimers();
  state.showWarning = false;
  state.secondsRemaining = 0;

  if (activityHandler) {
    for (const evt of ACTIVITY_EVENTS) {
      window.removeEventListener(evt, activityHandler);
    }
    activityHandler = null;
  }
  if (broadcast) {
    try {
      broadcast.close();
    } catch {
      /* ignore */
    }
    broadcast = null;
  }
  lastTouch = 0;
  lastActivityProcessed = 0;
}

/**
 * Called by the warning modal's "Stay signed in" button. Treats the
 * click as fresh activity — resets timers + immediately touches the
 * server (bypassing the 5-min throttle so the user has the full new
 * window even if they clicked late in the warning period).
 */
function stayActive(): void {
  lastTouch = 0; // bypass throttle
  startTimers();
  void touchServer();
  broadcast?.postMessage({ type: "activity", at: Date.now() });
}

export const sessionTimeoutStore = {
  get showWarning() {
    return state.showWarning;
  },
  get secondsRemaining() {
    return state.secondsRemaining;
  },
  get active() {
    return state.active;
  },
  init,
  destroy,
  stayActive,
  forceLogout,
};
