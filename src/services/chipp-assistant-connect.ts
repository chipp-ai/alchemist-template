/**
 * "Chipp" in the Settings AI assistants list: hand the signed-in member to
 * Chipp, which connects this app's MCP server to their chief of staff agent
 * and opens a chat about this app.
 *
 * The browser POSTs a short-lived token as a form to Chipp's
 * `POST /api/assistant-connect` (never in a URL). Chipp verifies it with the
 * same per-project secret it injected, so it knows which project sent the
 * person and from which address, and builds the MCP URL itself from an
 * address it knows the project serves.
 *
 * WIRE CONTRACT (must match chipp-deno
 * `src/alchemist/services/assistant-connect.service.ts`; a drift fails closed):
 *   key      UTF-8 bytes of hex(HMAC-SHA256(ALCH_MEMBER_SYNC_SECRET, "assistant-connect:v1"))
 *   header   alg HS256, typ "alch-assistant-connect+jwt"
 *   claims   iss "alchemist-app", aud "chipp-assistant-connect",
 *            sub = PROJECT_ID, email (lowercase), name (or null),
 *            origin (this app's public origin as the browser sees it),
 *            jti, iat, exp = iat + 120
 *
 * Own key label and audience, so this token can never pass as the
 * platform's sign-in handoff into the app (`member-handoff:v1`) or the
 * reverse. It signs nobody in anywhere: Chipp still requires its own
 * sign-in, and the MCP connection still runs this app's OAuth consent.
 */

import * as jose from "jose";
import { createHmac, randomBytes } from "node:crypto";
import { getEnv } from "@/lib/env.ts";

export const CONNECT_TYP = "alch-assistant-connect+jwt";
export const CONNECT_ISSUER = "alchemist-app";
export const CONNECT_AUDIENCE = "chipp-assistant-connect";
export const CONNECT_KEY_LABEL = "assistant-connect:v1";
export const CONNECT_TTL_SECONDS = 120;

/** Where Chipp's web app lives. CHIPP_WEB_URL overrides it for local dev. */
export function chippWebUrl(): string {
  const raw = getEnv("CHIPP_WEB_URL")?.trim();
  return (raw && /^https?:\/\//.test(raw) ? raw : "https://build.chipp.ai").replace(/\/+$/, "");
}

/** The signing key: UTF-8 bytes of the lowercase hex HMAC of the label. */
export function connectKey(syncSecret: string): Uint8Array {
  const hex = createHmac("sha256", new TextEncoder().encode(syncSecret))
    .update(CONNECT_KEY_LABEL)
    .digest("hex");
  return new TextEncoder().encode(hex);
}

export async function mintAssistantConnectToken(input: {
  syncSecret: string;
  projectId: string;
  email: string;
  name: string | null;
  origin: string;
  now?: Date;
}): Promise<string> {
  const iat = Math.floor((input.now ?? new Date()).getTime() / 1000);
  return await new jose.SignJWT({
    email: input.email.trim().toLowerCase(),
    name: input.name?.trim() || null,
    origin: input.origin,
  })
    .setProtectedHeader({ alg: "HS256", typ: CONNECT_TYP })
    .setIssuer(CONNECT_ISSUER)
    .setAudience(CONNECT_AUDIENCE)
    .setSubject(input.projectId)
    .setJti(randomBytes(24).toString("base64url"))
    .setIssuedAt(iat)
    .setExpirationTime(iat + CONNECT_TTL_SECONDS)
    .sign(connectKey(input.syncSecret));
}
