/**
 * Fill <img data-brand-logo> slots that mount after boot.
 *
 * web/public/brand-loader.js sets each logo `src` when brand.json loads,
 * but the sidebar and the portal header render later (after sign-in or a
 * lazy route). Call this from their onMount so the uploaded logo shows.
 * No-op when the loader did not run (no project id, local dev).
 */
export function applyBrandLogos(): void {
  const w = globalThis as unknown as { alchemistBrandReapply?: () => void };
  try {
    w.alchemistBrandReapply?.();
  } catch {
    // The logo is decoration; never break a page over it.
  }
}
