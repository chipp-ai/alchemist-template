/**
 * Portal SPA wiring: source-shape lint.
 *
 * The portal shell's value is what it does NOT contain. A regression here
 * is not a crash, it is an end user quietly handed the admin navigation,
 * or bounced to a workspace sign-in form they cannot complete. Neither
 * shows up as a failing request, so it gets linted.
 *
 * Source-text, like the repo's other design-system guards: the Svelte
 * layer has no component test harness here, and a shape test that pins
 * the wiring is worth more than no test at all.
 */

import { assert } from "@std/assert";

function deno(name: string, fn: () => void | Promise<void>) {
  Deno.test({ name, sanitizeResources: false, sanitizeOps: false, fn });
}

function read(rel: string): Promise<string> {
  return Deno.readTextFile(new URL(`../../${rel}`, import.meta.url));
}

// ── Routing ───────────────────────────────────────────────────────────────

deno("routes: /portal and the claim landing page are registered", async () => {
  const src = await read("web/src/routes.ts");
  assert(src.includes('"/portal": PortalHome'), "/portal must render the portal home");
  assert(
    src.includes('"/portal/claim/:token": PortalClaim'),
    "the emailed link must land on the claim page",
  );
});

deno(
  "routes: portal paths are public so a lapsed session is not bounced to admin login",
  async () => {
    // An end user whose session lapsed needs a new link, not the workspace
    // sign-in form. The DATA behind the page is still auth-gated server
    // side (GET /api/portal/me is scoped to the caller).
    //
    // Source-shape rather than a call: routes.ts imports .svelte modules,
    // which this runtime cannot parse. Same reason the design-system files
    // lint source text.
    const src = await read("web/src/routes.ts");
    assert(
      /PUBLIC_LITERAL_ROUTES = new Set\(\[[^\]]*"\/portal"/.test(src),
      "/portal must be public, or a lapsed portal session bounces to admin login",
    );
    assert(
      /PUBLIC_PREFIX_ROUTES = \[[^\]]*"\/portal\/"/.test(src),
      "the claim landing page must be public",
    );
    assert(
      /export function isPortalRoute[\s\S]{0,220}path === "\/portal"[\s\S]{0,120}startsWith\("\/portal\/"\)/
        .test(src),
      "isPortalRoute must match the portal namespace exactly, not by loose prefix",
    );
  },
);

deno("App: portal routes are excluded from the admin layout explicitly", async () => {
  const src = await read("web/src/App.svelte");
  assert(src.includes("isPortalRoute"), "App must know about portal routes");
  assert(
    /showLayout = \$derived\([\s\S]{0,200}!onPortalRoute/.test(src),
    "the admin layout must be suppressed on portal routes",
  );
});

// ── The shell ─────────────────────────────────────────────────────────────

deno("PortalLayout: carries brand, identity, and a sign-out, and nothing else", async () => {
  const src = await read("web/src/components/PortalLayout.svelte");
  for (const testid of ["portal-layout", "portal-brand", "portal-btn-signout"]) {
    assert(src.includes(`data-testid="${testid}"`), `missing data-testid="${testid}"`);
  }
});

deno("PortalLayout: has NO admin navigation", async () => {
  const src = await read("web/src/components/PortalLayout.svelte");
  // The whole point of a second shell. If a portal user needs one of
  // these, they are not a portal user; invite them properly.
  for (const forbidden of ["Sidebar", "/settings", "/inbound-emails", "/docs"]) {
    assert(
      !src.includes(forbidden),
      `the portal shell must not link to the admin surface (${forbidden})`,
    );
  }
});

deno("PortalLayout: sign-out returns to the portal, not the admin login", async () => {
  const src = await read("web/src/components/PortalLayout.svelte");
  assert(
    /logout\("#\/portal"\)/.test(src),
    "signing out of the portal must not land on the workspace sign-in form",
  );
});

deno("auth store: logout takes a redirect target, defaulting to the admin login", async () => {
  const src = await read("web/src/stores/auth.svelte.ts");
  assert(
    /function logout\(redirectTo = "#\/login"\)/.test(src),
    "logout must keep #/login as the default for admin surfaces",
  );
});

// ── The pages ─────────────────────────────────────────────────────────────

deno("PortalHome: reads ONLY the caller-scoped endpoint", async () => {
  const src = await read("web/src/routes/portal/PortalHome.svelte");
  assert(src.includes('"/portal/me"'), "the portal home must read /portal/me");
  // An org-scoped read here would defeat the lane: a portal session must
  // never be able to see another person's record.
  for (const forbidden of ["/portal/tokens", "/org/members", "/org/invites"]) {
    assert(!src.includes(forbidden), `the portal home must not call ${forbidden}`);
  }
  assert(src.includes("PortalLayout"), "the portal home must use the portal shell");
});

deno("PortalHome: renders a signed-out state instead of redirecting", async () => {
  const src = await read("web/src/routes/portal/PortalHome.svelte");
  assert(
    src.includes('data-testid="portal-signed-out"'),
    "a lapsed portal session needs a 'ask for a new link' state",
  );
  assert(src.includes("silent401"), "a 401 here must not bounce to the admin login");
});

deno("PortalClaim: claims with a POST fired by the page, never a bare GET", async () => {
  const src = await read("web/src/routes/portal/PortalClaim.svelte");
  assert(
    /api\.post\(\s*"\/portal\/claim"/.test(src),
    "the claim must be a POST, so a mail client's link prefetch cannot sign anyone in",
  );
  assert(src.includes("authStore.checkAuth"), "the new session must be picked up");
  assert(src.includes('replace("/portal")'), "a successful claim lands in the portal");
});
