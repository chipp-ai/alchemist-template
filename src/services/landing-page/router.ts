/**
 * landing-page recipe router stub.
 *
 * Mounted at `/` in `app.ts` for every recipe built from this repo, after
 * the API routes and before the SPA static fallback. The base router is
 * empty, so every request falls through to the next handler and the mount
 * is inert for every recipe except landing-page.
 *
 * The `marketing-site-scaffold` pack (landing-page recipe) replaces this
 * WHOLE FILE with a complete router that renders the public page at `/`,
 * `/sitemap.xml`, `/robots.txt` and `POST /api/leads`. Packs never write
 * `app.ts`: the composition engine would replace it wholesale.
 */
import { Hono } from "hono";

export const landingPageRouter = new Hono();
