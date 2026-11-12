/**
 * The page to open after sign-in. When a signed-out person opens a page
 * that needs a session, App.svelte remembers the route here before it sends
 * them to /login. The sign-in pages then take it: an email code or dev
 * sign-in pushes the route, and an OAuth button passes it to the server as
 * `?next=`, which the OAuth callback redirects to. With nothing remembered a
 * sign-in lands on the app home ("/" inside the app), never the landing site.
 *
 * Kept in sessionStorage (this tab only) and forgotten after 30 minutes or
 * once read. The route rule matches `safeAppRoute` in src/config/site.ts.
 */

const KEY = "app:return-to";
const MAX_AGE_MS = 30 * 60 * 1000;
const NOT_RETURN_ROUTES = new Set(["/", "/login", "/signup"]);

/** The minimal storage shape (a fake in tests). */
export interface ReturnToStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function defaultStore(): ReturnToStore | null {
  try {
    return (globalThis as { sessionStorage?: ReturnToStore }).sessionStorage ?? null;
  } catch {
    return null;
  }
}

/** A SPA route a sign-in may return to, or null (sign-in pages, "/", anything unsafe). */
export function safeReturnRoute(route: string | null | undefined): string | null {
  if (!route) return null;
  const v = route.trim();
  if (v.length === 0 || v.length > 512) return null;
  if (!v.startsWith("/") || v.startsWith("//")) return null;
  if (/[\\\s\u0000-\u001f\u007f]/.test(v)) return null;
  if (/^\/+[a-z][a-z0-9+.-]*:/i.test(v)) return null;
  const bare = v.split(/[?#]/, 1)[0].replace(/\/+$/, "") || "/";
  if (NOT_RETURN_ROUTES.has(bare)) return null;
  return v;
}

/** Remember the route a signed-out person asked for. Ignores routes not worth returning to. */
export function rememberReturnTo(
  route: string,
  now: number = Date.now(),
  store: ReturnToStore | null = defaultStore(),
): void {
  const safe = safeReturnRoute(route);
  if (!safe || !store) return;
  try {
    store.setItem(KEY, JSON.stringify({ route: safe, at: now }));
  } catch {
    // Storage blocked (private mode): the sign-in lands on the app home.
  }
}

/** The remembered route, once: it is forgotten as it is read. Null when none or expired. */
export function takeReturnTo(
  now: number = Date.now(),
  store: ReturnToStore | null = defaultStore(),
): string | null {
  if (!store) return null;
  try {
    const raw = store.getItem(KEY);
    store.removeItem(KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as { route?: unknown; at?: unknown };
    if (typeof v.route !== "string" || typeof v.at !== "number") return null;
    if (now - v.at > MAX_AGE_MS || now < v.at) return null;
    return safeReturnRoute(v.route);
  } catch {
    return null;
  }
}

/** The OAuth start URL for a provider, carrying the remembered route (taken) as `next`. */
export function oauthStartUrl(
  providerId: string,
  now: number = Date.now(),
  store: ReturnToStore | null = defaultStore(),
): string {
  const base = `/api/auth/${encodeURIComponent(providerId)}`;
  const next = takeReturnTo(now, store);
  return next ? `${base}?next=${encodeURIComponent(next)}` : base;
}
