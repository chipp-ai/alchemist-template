/**
 * Theme store — light/dark toggle, persisted to localStorage.
 *
 * Built on `defineStore` (see web/src/lib/devpanel/store.svelte.ts) so
 * the DevPanel + `/api/dev/app-state` can introspect the active theme
 * like every other piece of shared state.
 *
 * The actual "what should the default/resolved theme be" logic lives in
 * the pure, unit-tested web/src/lib/theme.ts module — this file is just
 * the reactive wiring: read localStorage once at boot, mirror every
 * change onto both the `data-theme` attribute (what app.css's
 * `[data-theme="dark"]` overrides key off) and localStorage (so it
 * survives a reload).
 *
 * DEFAULT LIGHT, never OS-auto: this module never reads
 * `prefers-color-scheme`. See web/src/lib/theme.ts's module doc and
 * docs/design-system-dark-mode.md for the rationale.
 *
 * Usage:
 *   import { themeStore } from "../stores/theme.svelte";
 *   themeStore.toggle();
 *   themeStore.isDark // boolean
 */
import { defineStore } from "../lib/devpanel/store.svelte";
import { nextTheme, resolveInitialTheme, THEME_STORAGE_KEY, type Theme } from "../lib/theme";

interface ThemeState {
  theme: Theme;
}

function readStoredTheme(): string | null {
  if (typeof localStorage === "undefined") return null;
  try {
    return localStorage.getItem(THEME_STORAGE_KEY);
  } catch {
    // Private-browsing / storage-disabled — resolveInitialTheme(null)
    // falls back to light, the safe default.
    return null;
  }
}

function applyThemeToDom(theme: Theme) {
  if (typeof document === "undefined") return;
  document.documentElement.setAttribute("data-theme", theme);
}

const state = defineStore<ThemeState>("theme", {
  theme: resolveInitialTheme(readStoredTheme()),
});

// Sync the DOM attribute immediately on module load. web/index.html
// also sets `data-theme` synchronously pre-paint (see its inline
// script) so the browser never flashes light->dark on reload; this
// call is what keeps the store's reactive state and the DOM in
// agreement once the store takes over as the source of truth (a
// harmless no-op re-set when the inline script already got it right).
applyThemeToDom(state.theme);

function setTheme(theme: Theme) {
  state.theme = theme;
  applyThemeToDom(theme);
  if (typeof localStorage !== "undefined") {
    try {
      localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch {
      // Private browsing / quota exceeded — the theme still applies
      // for this session via reactive state + the DOM attribute, it
      // just won't survive a reload. Never let persistence failure
      // block the user's toggle.
    }
  }
}

function toggle() {
  setTheme(nextTheme(state.theme));
}

export const themeStore = {
  get theme() {
    return state.theme;
  },
  get isDark() {
    return state.theme === "dark";
  },
  setTheme,
  toggle,
};
