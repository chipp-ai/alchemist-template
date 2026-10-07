/**
 * Built-in features (src/lib/features.ts) through the REAL app.ts mounts.
 *
 * The API and MCP features ship in every project and stay OFF until the
 * project turns them on. While off, every route they own must answer 404,
 * exactly as if it did not exist: an unauthenticated probe must not learn
 * that an API or an MCP server is there (a 401 would say so). Turning one
 * on must not switch the other on, and the gates must never swallow a base
 * route that shares the /api prefix.
 *
 * No DB needed: every assertion stops at the gate or at auth.
 */
import { assert, assertEquals } from "@std/assert";
import { app } from "../../../app.ts";
import { setFeatureForTests } from "@/lib/features.ts";
import { getEnv } from "@/lib/env.ts";

function test(name: string, fn: () => Promise<void>) {
  Deno.test({ name, sanitizeResources: false, sanitizeOps: false, fn });
}

const API_PROBES: Array<[string, string]> = [
  ["GET", "/api/api-keys"],
  ["POST", "/api/api-keys"],
  ["DELETE", "/api/api-keys/00000000-0000-0000-0000-000000000000"],
  ["GET", "/api/v1/team-summary"],
  ["GET", "/api/v1"],
];

const MCP_PROBES: Array<[string, string]> = [
  ["POST", "/api/mcp"],
  ["GET", "/api/mcp"],
  ["POST", "/api/mcp/oauth/register"],
  ["POST", "/api/mcp/oauth/token"],
  ["GET", "/api/mcp/oauth/authorize"],
  ["GET", "/api/mcp/api-keys"],
  ["GET", "/.well-known/oauth-authorization-server"],
  ["GET", "/.well-known/oauth-authorization-server/api/mcp"],
  ["GET", "/.well-known/oauth-protected-resource"],
  ["GET", "/.well-known/oauth-protected-resource/api/mcp"],
];

async function status(method: string, path: string): Promise<number> {
  const res = await app.request(path, {
    method,
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: method === "GET" ? undefined : "{}",
  });
  await res.body?.cancel();
  return res.status;
}

function withFeatures(api: boolean, mcp: boolean, fn: () => Promise<void>) {
  return async () => {
    setFeatureForTests("api", api);
    setFeatureForTests("mcp", mcp);
    try {
      await fn();
    } finally {
      setFeatureForTests("api", null);
      setFeatureForTests("mcp", null);
    }
  };
}

test(
  "both off (the default): every API and MCP route answers 404",
  withFeatures(false, false, async () => {
    for (const [method, path] of [...API_PROBES, ...MCP_PROBES]) {
      assertEquals(await status(method, path), 404, `${method} ${path}`);
    }
  }),
);

test(
  "both off: base routes that share /api are untouched (auth answers 401, not 404)",
  withFeatures(false, false, async () => {
    assertEquals(await status("GET", "/api/auth/me"), 401);
    assertEquals(await status("GET", "/api/org"), 401);
  }),
);

test(
  "api on: its routes exist (401 without auth), MCP stays 404",
  withFeatures(true, false, async () => {
    assertEquals(await status("GET", "/api/api-keys"), 401);
    assertEquals(await status("GET", "/api/v1/team-summary"), 401);
    for (const [method, path] of MCP_PROBES) {
      assertEquals(await status(method, path), 404, `${method} ${path}`);
    }
  }),
);

test(
  "mcp on: discovery is served, the endpoint and key routes exist, the API stays 404",
  withFeatures(false, true, async () => {
    const res = await app.request("/.well-known/oauth-authorization-server");
    assertEquals(res.status, 200);
    const doc = await res.json();
    assert(String(doc.registration_endpoint).endsWith("/api/mcp/oauth/register"));
    assertEquals(await status("GET", "/.well-known/oauth-protected-resource/api/mcp"), 200);
    // MCP_AUTH_MODE defaults to "public", so the endpoint itself answers
    // (not 401); the point is that it exists now.
    assert(await status("POST", "/api/mcp") !== 404);
    assertEquals(await status("GET", "/api/mcp/api-keys"), 401);
    for (const [method, path] of API_PROBES) {
      assertEquals(await status(method, path), 404, `${method} ${path}`);
    }
  }),
);

test(
  "both on: both surfaces answer, and base routes still work",
  withFeatures(true, true, async () => {
    assertEquals(await status("GET", "/api/api-keys"), 401);
    assertEquals(await status("GET", "/api/v1/team-summary"), 401);
    assert(await status("POST", "/api/mcp") !== 404);
    assertEquals(await status("GET", "/.well-known/oauth-authorization-server"), 200);
    assertEquals(await status("GET", "/api/auth/me"), 401);
  }),
);

test("the env vars are the switch: exactly \"1\" or \"true\" turns a feature on", async () => {
  const { featureEnabled, FEATURE_ENV_VARS } = await import("@/lib/features.ts");
  // This worker's module-level overrides are clear here, so env decides.
  // Deno.env is shared across parallel test workers, so only READ it.
  for (const feature of ["api", "mcp"] as const) {
    const v = getEnv(FEATURE_ENV_VARS[feature]);
    assertEquals(featureEnabled(feature), v === "1" || v === "true");
  }
  assertEquals(FEATURE_ENV_VARS, { api: "ALCHEMIST_FEATURE_API", mcp: "ALCHEMIST_FEATURE_MCP" });
});
