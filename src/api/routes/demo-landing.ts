/**
 * Demo-mode public landing page.
 *
 * Part of the shared DEMO_MODE contract (see docs/demo-mode.md). The base
 * template's real SPA is auth-gated (its only unauthenticated screen is
 * the login form), so a visitor landing on a live demo pod at `/` with no
 * account would otherwise see nothing but a login box -- not "something
 * meaningful without a login". This route replaces the EXACT `/` path
 * with a small, server-rendered, read-only page explaining what the
 * template ships and linking into the repo README's sections, plus a CTA
 * into the live SPA itself (reachable at `/index.html`, since this route
 * only intercepts the bare `/` path -- the static file is untouched).
 *
 * Complete no-op when DEMO_MODE is off: calls `next()` immediately, so
 * `/` falls through to the SPA static-file fallback exactly as before
 * this route existed.
 */

import { createMiddleware } from "hono/factory";
import { isDemoMode } from "@/config/demo-mode.ts";

const REPO_URL = "https://github.com/chipp-ai/alchemist-template";

const FEATURES: ReadonlyArray<{ title: string; body: string }> = [
  { title: "API", body: "Deno 2 + Hono 4 with Zod request validation and typed error handling." },
  { title: "SPA", body: "Svelte 5 (runes) + Vite, hash-based router, typed fetch wrapper." },
  {
    title: "Database",
    body:
      "PostgreSQL via Kysely with CamelCasePlugin. Migrations are plain SQL, auto-applied on startup.",
  },
  {
    title: "Auth",
    body: "Email OTP login, session cookies, JWT, OAuth providers via Arctic 2.",
  },
  {
    title: "Billing",
    body:
      "Stripe 17 -- plan-tier subscriptions plus a built-in product catalog for one-time and subscription sales.",
  },
  {
    title: "RBAC + teams",
    body: "Organizations, members, roles, and invites, wired through the auth middleware.",
  },
  {
    title: "Observability",
    body: "Structured logging (pretty in dev, NDJSON in production), ready for Loki / Datadog.",
  },
  {
    title: "Agent-native",
    body:
      "A CLAUDE.md authored so AI coding agents can extend the app without breaking its conventions.",
  },
];

const README_LINKS: ReadonlyArray<{ label: string; href: string }> = [
  { label: "What's in the box", href: `${REPO_URL}#whats-in-the-box` },
  { label: "Architecture", href: `${REPO_URL}#architecture` },
  { label: "Quick start", href: `${REPO_URL}#quick-start` },
  { label: "Project structure", href: `${REPO_URL}#project-structure` },
  { label: "Customizing for your product", href: `${REPO_URL}#customizing-for-your-product` },
];

function escapeHtml(input: string): string {
  return input
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderLandingPage(): string {
  const featureItems = FEATURES.map(
    (f) => `<li><strong>${escapeHtml(f.title)}</strong> &mdash; ${escapeHtml(f.body)}</li>`,
  ).join("\n");

  const readmeItems = README_LINKS.map(
    (l) => `<li><a href="${escapeHtml(l.href)}">${escapeHtml(l.label)}</a></li>`,
  ).join("\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Alchemist SaaS Starter -- Live Demo</title>
<style>
  body { margin: 0; font: 16px/1.6 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; color: #111827; background: #f9fafb; }
  main { max-width: 760px; margin: 0 auto; padding: 3rem 1.5rem 4rem; }
  h1 { font-size: 2rem; margin-bottom: 0.25rem; }
  p.lede { color: #4b5563; font-size: 1.1rem; }
  ul { padding-left: 1.25rem; }
  li { margin-bottom: 0.5rem; }
  .cta { display: inline-block; margin: 1.5rem 0; padding: 0.75rem 1.5rem; background: #4f46e5; color: #fff; text-decoration: none; border-radius: 0.375rem; font-weight: 600; }
  .cta:hover { background: #4338ca; }
  section { margin-top: 2.5rem; }
  h2 { font-size: 1.25rem; border-bottom: 1px solid #e5e7eb; padding-bottom: 0.5rem; }
  footer { margin-top: 3rem; color: #6b7280; font-size: 0.9rem; }
</style>
</head>
<body>
<main>
  <h1>Alchemist SaaS Starter</h1>
  <p class="lede">
    This is a live, fictional demo of the production-grade SaaS template that
    <a href="https://adaas.dev">Alchemist AI</a> ships to every new customer
    project. Nothing on this deployment is real -- no real users, no real
    payments, no real email.
  </p>

  <a class="cta" href="/index.html#/login">Open the live demo app &rarr;</a>

  <section>
    <h2>What ships in the box</h2>
    <ul>
      ${featureItems}
    </ul>
  </section>

  <section>
    <h2>Read more</h2>
    <ul>
      ${readmeItems}
    </ul>
    <p><a href="${escapeHtml(REPO_URL)}">View the full source on GitHub &rarr;</a></p>
  </section>

  <footer>Live demo of the SaaS Starter template on Alchemist -- all content is fictional.</footer>
</main>
</body>
</html>`;
}

/**
 * `GET /` -- the demo landing page when DEMO_MODE=1, otherwise falls
 * through to whatever handled `/` before (the SPA static fallback).
 * Registered ahead of the static-file middleware in app.ts so it wins
 * the exact-path match while DEMO_MODE is on.
 */
export const demoLandingRoute = createMiddleware(async (c, next) => {
  if (!isDemoMode()) return next();
  return c.html(renderLandingPage());
});
