/**
 * Client Tickets Portal router stub. EMPTY in the base template.
 *
 * Mounted at `/api/tickets-and-billing` in `app.ts` for every project. The
 * base router is empty, so the mount is inert until a builder turns the
 * Client Tickets Portal on. The platform's client-tickets-portal pack then
 * REPLACES this whole file with a complete router (the owner-only ticket
 * queue and ledger summary), and restores this exact content when the
 * portal is turned off. Packs never write `app.ts`: the composition engine
 * would replace it wholesale.
 */
import { Hono } from "hono";

export const clientTicketsPortalRouter = new Hono();
