/**
 * Agency CMS router stub.
 *
 * Mounted at `/` in `app.ts` for every project built from this repo, after
 * the API routes and before the landing-page stub and the SPA fallback. The
 * base router is empty, so every request falls through and the mount is
 * inert for every project that has not turned the CMS on.
 *
 * The `cms-admin-shell` pack (agency-cms recipe, or a CMS install into an
 * existing project) replaces this WHOLE FILE with a complete router: the
 * authenticated CMS API under `/api/cms` and the public client sites,
 * resolved by Host header or served at `/_sites/<slug>/`. Packs never write
 * `app.ts`: the composition engine would replace it wholesale.
 */
import { Hono } from "hono";

export const cmsRouter = new Hono();
