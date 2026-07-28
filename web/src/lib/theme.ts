/**
 * Pure theme-resolution logic, extracted from the reactive store
 * (web/src/stores/theme.svelte.ts) so the "default light, never
 * OS-auto" contract can be unit-tested directly under Deno without a
 * Svelte compile step — the same split used by web/src/lib/color-math.ts
 * (pure math module) vs. brand-loader.js (DOM wiring).
 *
 * Dark mode in this template is a user-chosen THEME, never inferred
 * from the OS. Per docs/design-system-program.md's S1 section:
 * "DEFAULT LIGHT, never OS-auto partial theming." Nothing in this
 * module (or its caller) reads `prefers-color-scheme` to decide the
 * app theme — the only two inputs are (1) an explicit "dark" value the
 * user previously chose, persisted to localStorage, and (2) the
 * default, light.
 */

export type Theme = "light" | "dark";

/** localStorage key the store + the anti-FOUC inline script in
 * web/index.html both read/write. Keep these in sync — the inline
 * script can't import this module (it runs unbundled, before Vite's
 * module graph loads), so it duplicates the literal string. */
export const THEME_STORAGE_KEY = "alchemist-theme";

/**
 * Resolve the active theme from whatever localStorage held (or null /
 * undefined / garbage). Anything other than the exact literal string
 * "dark" resolves to "light" — that is what makes light the default:
 * a fresh browser, a cleared localStorage, a value some unrelated
 * script wrote, or a typo'd/legacy value all fail SAFE to light
 * instead of guessing at intent.
 */
export function resolveInitialTheme(stored: string | null | undefined): Theme {
  return stored === "dark" ? "dark" : "light";
}

/** The only two states in this system — flips between them. */
export function nextTheme(current: Theme): Theme {
  return current === "dark" ? "light" : "dark";
}
