/**
 * embedded-chipp-agent feature stub.
 *
 * Mounted at `/api/embedded-agent` in `app.ts` for every project built from
 * this repo. The base router is empty, so the mount is inert until a builder
 * turns the embedded Chipp agent on.
 *
 * The `embedded-chipp-agent` pack replaces this WHOLE FILE with the session
 * proxy routes (`POST /session`, `POST /session/anonymous`) that mint a
 * short-lived chat token server-side. Packs never write `app.ts`: the
 * composition engine would replace it wholesale. A file that still holds
 * this exact content counts as untouched, so turning the feature on later is
 * a clean apply.
 */
import { Hono } from "hono";

export const embeddedAgentRouter = new Hono();
