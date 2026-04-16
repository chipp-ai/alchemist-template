/**
 * Auth store using Svelte 5 runes.
 *
 * Tracks the current user session, provides login/signup/logout,
 * and exposes derived `isAuthenticated` / `isLoading` state.
 */

import { api, ApiError } from "../lib/api";

// ---------- Types ----------

export interface User {
  id: string;
  email: string;
  name: string;
  role: string;
  organizationId: string | null;
}

// ---------- State ----------

let user = $state<User | null>(null);
let isLoading = $state(true);
let error = $state<string | null>(null);

// ---------- Derived ----------

const isAuthenticated = $derived(user !== null);

// ---------- Actions ----------

async function checkAuth(): Promise<void> {
  isLoading = true;
  error = null;
  try {
    const data = await api.get<{ user: User }>("/auth/me");
    user = data.user;
  } catch (err) {
    // 401 is expected when not logged in
    if (err instanceof ApiError && err.status === 401) {
      user = null;
    } else {
      console.error("Auth check failed:", err);
      user = null;
    }
  } finally {
    isLoading = false;
  }
}

async function sendOtp(email: string, name?: string): Promise<void> {
  error = null;
  try {
    await api.post("/auth/send-otp", {
      email: email.toLowerCase().trim(),
      ...(name ? { name: name.trim() } : {}),
    });
  } catch (err) {
    const message =
      err instanceof ApiError
        ? err.message
        : "Failed to send code. Please try again.";
    error = message;
    throw err;
  }
}

async function verifyOtp(
  email: string,
  otpCode: string,
  name?: string,
): Promise<void> {
  error = null;
  try {
    const data = await api.post<{ user: User }>("/auth/verify-otp", {
      email: email.toLowerCase().trim(),
      otpCode,
      ...(name ? { name: name.trim() } : {}),
    });
    user = data.user;
  } catch (err) {
    const message =
      err instanceof ApiError
        ? err.message
        : "Verification failed. Please try again.";
    error = message;
    throw err;
  }
}

async function logout(): Promise<void> {
  try {
    await api.post("/auth/logout");
  } catch {
    // Swallow errors -- we clear state regardless
  }
  user = null;
  window.location.hash = "#/login";
}

// ---------- Export ----------

export const authStore = {
  get user() {
    return user;
  },
  get isLoading() {
    return isLoading;
  },
  get isAuthenticated() {
    return isAuthenticated;
  },
  get error() {
    return error;
  },
  checkAuth,
  sendOtp,
  verifyOtp,
  logout,
};
