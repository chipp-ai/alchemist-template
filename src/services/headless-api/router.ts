/**
 * Headless API router stub (the `api` recipe).
 *
 * `app.ts` mounts this router at `/api` for every recipe built from this
 * monorepo. Here it is empty, so the mount is inert: it registers no route
 * and no middleware, and every other `/api` route answers as if it were not
 * there.
 *
 * The `headless-api-surface` pack (chipp-deno
 * src/alchemist/services/template-packs/) replaces this whole file in `api`
 * projects with a router that registers the API-product routes
 * (`/api/api-keys` and whatever the project adds). The `mcp-protocol-surface`
 * pack does the same to mount `/api/api-keys` in `mcp-server` projects. The
 * pack overlay writes the complete file: it never appends to this one. Keep
 * the export name `headlessApiRouter`, since `app.ts` imports it.
 *
 * There is no middleware here on purpose. A `use("*")` on a router mounted at
 * `/api` runs for every `/api` request that reaches it, so a gate here would
 * 404 any `/api` route a recipe registers after this mount.
 */
import { Hono } from "hono";

export const headlessApiRouter = new Hono();
