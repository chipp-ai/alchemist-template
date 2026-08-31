/**
 * Auth store — current user session + login/signup/logout actions.
 *
 * Built on `defineStore` (the canonical store factory — see
 * web/src/lib/devpanel/store.svelte.ts). Every shared store in this
 * app follows the same pattern so the dev panel can introspect them
 * at runtime.
 *
 * Update convention: top-level property assignment only. Whole-object
 * replacements like `state.user = newUser` notify the dev panel
 * immediately. Avoid nested mutation (`state.user.name = "X"`) — see
 * the CLAUDE.md "Stores and the DevPanel" section for the rationale.
 */

import { api, ApiError } from "../lib/api";
import { defineStore } from "../lib/devpanel/store.svelte";
import { identifyChippInsightsUser } from "../lib/chipp-insights";

// ---------- Types ----------

export interface User {
  id: string;
  email: string;
  name: string;
  role: string;
  organizationId: string | null;
}

interface AuthState {
  user: User | null;
  isLoading: boolean;
  error: string | null;
  /**
   * Deployment-scoped HIPAA flag. Sourced from /auth/me, which reads
   * the customer pod's HIPAA_ENABLED env var. When true, the SPA arms
   * activity tracking + the 4-hour session-timeout warning.
   */
  hipaaEnabled: boolean;
  /** Session TTL in ms — 4 h on HIPAA pods, 30 d otherwise. */
  sessionDurationMs: number;
}

// ---------- State ----------

const state = defineStore<AuthState>("auth", {
  user: null,
  isLoading: true,
  error: null,
  hipaaEnabled: false,
  sessionDurationMs: 30 * 24 * 60 * 60 * 1000,
});

// ---------- Actions ----------

async function checkAuth(): Promise<void> {
  state.isLoading = true;
  state.error = null;
  try {
    // silent401: we expect this to 401 when no session exists yet (e.g.
    // the very first page load after a fresh open, or right after the
    // user lands on /signup). Without the silent flag, the api client
    // redirects to /login on 401 — which fights with App.svelte's own
    // routing and bounces a freshly-signed-up user from /signup back to
    // /login the moment checkAuth runs on mount.
    const data = await api.get<{
      user: User;
      hipaaEnabled?: boolean;
      sessionDurationMs?: number;
    }>("/auth/me", { silent401: true });
    state.user = data.user;
    state.hipaaEnabled = data.hipaaEnabled ?? false;
    state.sessionDurationMs = data.sessionDurationMs ?? 30 * 24 * 60 * 60 * 1000;
    identifyChippInsightsUser(data.user.email);
  } catch (err) {
    // 401 is expected when not logged in.
    if (err instanceof ApiError && err.status === 401) {
      state.user = null;
    } else {
      console.error("Auth check failed:", err);
      state.user = null;
    }
  } finally {
    state.isLoading = false;
  }
}

async function sendOtp(email: string, name?: string): Promise<void> {
  state.error = null;
  try {
    await api.post("/auth/send-otp", {
      email: email.toLowerCase().trim(),
      ...(name ? { name: name.trim() } : {}),
    });
  } catch (err) {
    const message = err instanceof ApiError
      ? err.message
      : "Failed to send code. Please try again.";
    state.error = message;
    throw err;
  }
}

async function verifyOtp(
  email: string,
  otpCode: string,
  name?: string,
): Promise<void> {
  state.error = null;
  try {
    const data = await api.post<{ user: User }>("/auth/verify-otp", {
      email: email.toLowerCase().trim(),
      otpCode,
      ...(name ? { name: name.trim() } : {}),
    });
    state.user = data.user;
    identifyChippInsightsUser(data.user.email);
  } catch (err) {
    const message = err instanceof ApiError
      ? err.message
      : "Verification failed. Please try again.";
    state.error = message;
    throw err;
  }
}

/**
 * Sign out and land somewhere sensible.
 *
 * `redirectTo` exists for the end-user portal lane: a portal user who
 * signs out must see "ask for a new link" (`#/portal`), not the
 * workspace's admin sign-in form, which they have no business
 * completing. Admin surfaces keep the default.
 */
async function logout(redirectTo = "#/login"): Promise<void> {
  try {
    await api.post("/auth/logout");
  } catch {
    // Swallow errors — we clear state regardless.
  }
  state.user = null;
  window.location.hash = redirectTo;
}

// ---------- Export ----------

/**
 * Read-only(-ish) interface for components and other stores. The
 * underlying `state` object is also reactive, but consumers should
 * go through this getter-shape API for stability.
 */
export const authStore = {
  get user() {
    return state.user;
  },
  get isLoading() {
    return state.isLoading;
  },
  get error() {
    return state.error;
  },
  get isAuthenticated() {
    return state.user !== null;
  },
  get hipaaEnabled() {
    return state.hipaaEnabled;
  },
  get sessionDurationMs() {
    return state.sessionDurationMs;
  },
  checkAuth,
  sendOtp,
  verifyOtp,
  logout,
};
