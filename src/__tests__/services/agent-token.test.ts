/**
 * Agent tokens (src/services/agent-tools/agent-token.ts), no DB.
 *
 * The contract with the Chipp side: HS256 with JWT_SECRET, claims
 * { sub, organizationId, role, scope: "agent", aud: "chipp-embed", aid?,
 * jti, iat, exp = iat + 15 min }. verifyAgentToken accepts nothing else.
 */

import { assert, assertEquals, assertRejects } from "@std/assert";
import * as jose from "jose";
import {
  AGENT_TOKEN_AUDIENCE,
  AGENT_TOKEN_TTL_SECONDS,
  AgentTokenConfigError,
  mintAgentToken,
  verifyAgentToken,
} from "@/services/agent-tools/agent-token.ts";
import { createSessionToken, createWsToken } from "@/api/middleware/auth.ts";
import { __deleteEnvForTest, __setEnvForTest, getEnv } from "@/lib/env.ts";
import { embeddedAgentSessionExtras } from "@/services/embedded-agent/session-extras.ts";

const ORIGINAL_SECRET = getEnv("JWT_SECRET");
// Agent tokens never fall back to a development secret, so this file needs
// one. When the env already has JWT_SECRET (CI, .env) the session layer
// signs with the same value.
const SECRET = ORIGINAL_SECRET ?? "agent-token-test-secret";
__setEnvForTest("JWT_SECRET", SECRET);
const KEY = new TextEncoder().encode(SECRET);

const USER = {
  id: "11111111-1111-4111-8111-111111111111",
  email: "agent-token@test.local",
  name: "Agent Token",
  organizationId: "22222222-2222-4222-8222-222222222222",
  role: "editor",
};

/** Sign arbitrary claims with the app key, for negative cases. */
async function forge(
  claims: Record<string, unknown>,
  opts: { iat?: number; exp?: number; aud?: string | null; jti?: boolean } = {},
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  let jwt = new jose.SignJWT(claims)
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(USER.id)
    .setIssuedAt(opts.iat ?? now)
    .setExpirationTime(opts.exp ?? now + 600);
  if (opts.aud !== null) jwt = jwt.setAudience(opts.aud ?? AGENT_TOKEN_AUDIENCE);
  if (opts.jti !== false) jwt = jwt.setJti(crypto.randomUUID());
  return await jwt.sign(KEY);
}

const AGENT_CLAIMS = { organizationId: USER.organizationId, role: USER.role, scope: "agent" };

Deno.test("agent token: mint carries the contract claims and verifies", async () => {
  const token = await mintAgentToken(USER);
  const payload = await verifyAgentToken(token);
  assert(payload, "a freshly minted token verifies");
  assertEquals(payload.sub, USER.id);
  assertEquals(payload.organizationId, USER.organizationId);
  assertEquals(payload.role, USER.role);
  assertEquals(payload.scope, "agent");
  assertEquals(payload.aud, "chipp-embed");
  assertEquals(payload.exp - payload.iat, AGENT_TOKEN_TTL_SECONDS);
  assertEquals(AGENT_TOKEN_TTL_SECONDS, 900);
  assert(typeof payload.jti === "string" && payload.jti.length > 0);
  assertEquals(jose.decodeProtectedHeader(token).alg, "HS256");
  // Not bound to an agent application unless the env says so.
  assertEquals(payload.aid, undefined);

  const second = await mintAgentToken(USER);
  assert((await verifyAgentToken(second))!.jti !== payload.jti, "every token gets its own jti");
});

Deno.test("agent token: aid is stamped from CHIPP_AGENT_APPLICATION_ID and must match", async () => {
  __setEnvForTest("CHIPP_AGENT_APPLICATION_ID", "app_one");
  try {
    const token = await mintAgentToken(USER);
    assertEquals((await verifyAgentToken(token))?.aid, "app_one");

    __setEnvForTest("CHIPP_AGENT_APPLICATION_ID", "app_two");
    assertEquals(
      await verifyAgentToken(token),
      null,
      "a token for another agent application is refused",
    );

    const noAid = await forge(AGENT_CLAIMS);
    assertEquals(await verifyAgentToken(noAid), null, "a bound app requires the aid claim");
  } finally {
    __deleteEnvForTest("CHIPP_AGENT_APPLICATION_ID");
  }
});

Deno.test("agent token: verify refuses session and WS tokens (scope segregation)", async () => {
  assertEquals(await verifyAgentToken(await createSessionToken(USER)), null);
  assertEquals(await verifyAgentToken(await createWsToken(USER)), null);
});

Deno.test("agent token: verify refuses expired, wrong aud, wrong scope, long-lived and foreign tokens", async () => {
  const now = Math.floor(Date.now() / 1000);

  // The control: a well-formed forged token passes, so each case below
  // fails for the reason it names.
  assert(await verifyAgentToken(await forge(AGENT_CLAIMS)));

  const expired = await forge(AGENT_CLAIMS, { iat: now - 1000, exp: now - 100 });
  assertEquals(await verifyAgentToken(expired), null, "expired");

  assertEquals(
    await verifyAgentToken(await forge(AGENT_CLAIMS, { aud: "someone-else" })),
    null,
    "aud mismatch",
  );
  assertEquals(await verifyAgentToken(await forge(AGENT_CLAIMS, { aud: null })), null, "no aud");
  assertEquals(
    await verifyAgentToken(await forge({ ...AGENT_CLAIMS, scope: "ws" })),
    null,
    "scope ws",
  );
  assertEquals(
    await verifyAgentToken(await forge({ ...AGENT_CLAIMS, scope: undefined })),
    null,
    "no scope",
  );
  assertEquals(await verifyAgentToken(await forge(AGENT_CLAIMS, { jti: false })), null, "no jti");
  assertEquals(
    await verifyAgentToken(await forge({ role: "owner", scope: "agent" })),
    null,
    "no organizationId",
  );
  assertEquals(
    await verifyAgentToken(await forge(AGENT_CLAIMS, { exp: now + 3600 })),
    null,
    "a lifetime over 15 minutes was not minted here",
  );

  const foreign = await new jose.SignJWT(AGENT_CLAIMS)
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(USER.id)
    .setAudience(AGENT_TOKEN_AUDIENCE)
    .setJti(crypto.randomUUID())
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(new TextEncoder().encode("a-different-secret"));
  assertEquals(await verifyAgentToken(foreign), null, "foreign signature");
  assertEquals(await verifyAgentToken("not-a-jwt"), null);
  assertEquals(await verifyAgentToken(""), null);
});

Deno.test("agent token: fails closed without JWT_SECRET (no development fallback)", async () => {
  const token = await mintAgentToken(USER);
  __deleteEnvForTest("JWT_SECRET");
  try {
    await assertRejects(() => mintAgentToken(USER), AgentTokenConfigError);
    assertEquals(await verifyAgentToken(token), null);

    // A token signed with the session layer's fallback is refused too.
    const devSigned = await new jose.SignJWT(AGENT_CLAIMS)
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(USER.id)
      .setAudience(AGENT_TOKEN_AUDIENCE)
      .setJti(crypto.randomUUID())
      .setIssuedAt()
      .setExpirationTime("10m")
      .sign(new TextEncoder().encode("development-secret"));
    assertEquals(await verifyAgentToken(devSigned), null);

    // The session proxy still mints a chat session, just without tools.
    assertEquals(await embeddedAgentSessionExtras(USER), {});
  } finally {
    __setEnvForTest("JWT_SECRET", SECRET);
  }
});

Deno.test("embeddedAgentSessionExtras: agentToken + agentToolsUrl on APP_URL", async () => {
  __setEnvForTest("APP_URL", "https://example-app.test/");
  try {
    const extras = await embeddedAgentSessionExtras(USER);
    assert("agentToken" in extras);
    assertEquals(extras.agentToolsUrl, "https://example-app.test/api/agent-mcp");
    const payload = await verifyAgentToken(extras.agentToken);
    assertEquals(payload?.sub, USER.id);
    assertEquals(payload?.organizationId, USER.organizationId);
    assertEquals(Object.keys(extras).sort(), ["agentToken", "agentToolsUrl"]);
  } finally {
    __deleteEnvForTest("APP_URL");
  }
});
