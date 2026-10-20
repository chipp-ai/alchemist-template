/**
 * Support page router stub. EMPTY in the base template.
 *
 * Mounted at `/api/support` in `app.ts` for every project. The base router
 * is empty, so the mount is inert (404) until a builder turns on "Support
 * page for app users". The platform's app-support pack then REPLACES this
 * whole file with a complete router, and restores this exact content when
 * the feature is turned off. Packs never write `app.ts`: the composition
 * engine would replace it wholesale.
 */
import { Hono } from "hono";

export const supportRouter = new Hono();
