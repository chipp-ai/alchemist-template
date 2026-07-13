/**
 * Pins the prebuilt SSO provider registry contract: the four stock
 * providers exist with env-gated enablement, the Salesforce builder
 * honors the sandbox base-URL override, and the generic OIDC slot only
 * materializes when its endpoint env vars are set. Builder agents are
 * told (CLAUDE.md → "Social login / SSO is prebuilt") that enabling SSO
 * is env vars only, no code; these tests keep that promise honest.
 */

import { assert, assertEquals } from "@std/assert";
import {
  buildSalesforceProvider,
  findProvider,
  oidcProviderEntries,
  PROVIDERS,
} from "@/lib/oauth-providers.ts";

Deno.test("registry: google, microsoft, github, salesforce are always present", () => {
  for (const id of ["google", "microsoft", "github", "salesforce"]) {
    const p = findProvider(id);
    assert(p, `provider ${id} missing from PROVIDERS`);
    assert(p.clientIdEnv.length > 0 && p.clientSecretEnv.length > 0);
    assert(p.authUrl.startsWith("https://"));
    assert(p.tokenUrl.startsWith("https://"));
    assert(p.userInfoUrl.startsWith("https://"));
  }
});

Deno.test("registry: provider ids never collide with reserved auth route paths", () => {
  const reserved = new Set(["send-otp", "verify-otp", "logout", "me", "config"]);
  for (const p of PROVIDERS) {
    assert(!reserved.has(p.id), `provider id ${p.id} collides with a reserved auth path`);
  }
});

Deno.test("salesforce: defaults to login.salesforce.com, sandbox override honored", () => {
  const prod = buildSalesforceProvider(undefined);
  assertEquals(prod.authUrl, "https://login.salesforce.com/services/oauth2/authorize");
  assertEquals(prod.userInfoUrl, "https://login.salesforce.com/services/oauth2/userinfo");

  const sandbox = buildSalesforceProvider("https://test.salesforce.com/");
  assertEquals(sandbox.tokenUrl, "https://test.salesforce.com/services/oauth2/token");

  // Standard userinfo mapping incl. the user_id → sub fallthrough.
  const mapped = prod.mapUser({
    email: "User@Example.COM ",
    name: "U Ser",
    picture: null,
    user_id: "005xx0000012345",
  });
  assertEquals(mapped.email, "user@example.com");
  assertEquals(mapped.providerUserId, "005xx0000012345");
});

Deno.test("oidc slot: absent without endpoint envs, present and mapped with them", () => {
  assertEquals(oidcProviderEntries({}), []);
  assertEquals(
    oidcProviderEntries({ OIDC_AUTH_URL: "https://kc.example.com/realms/x/protocol/openid-connect/auth" }),
    [],
    "partial endpoint config must not materialize the provider",
  );

  const [p] = oidcProviderEntries({
    OIDC_AUTH_URL: "https://kc.example.com/realms/x/protocol/openid-connect/auth",
    OIDC_TOKEN_URL: "https://kc.example.com/realms/x/protocol/openid-connect/token",
    OIDC_USERINFO_URL: "https://kc.example.com/realms/x/protocol/openid-connect/userinfo",
    OIDC_LABEL: "Continue with Acme SSO",
  });
  assert(p);
  assertEquals(p.id, "oidc");
  assertEquals(p.label, "Continue with Acme SSO");
  assertEquals(p.scopes, "openid email profile");
  assertEquals(p.clientIdEnv, "OIDC_CLIENT_ID");

  const mapped = p.mapUser({ email: "A@B.co", preferred_username: "ab", sub: "abc-123" });
  assertEquals(mapped.email, "a@b.co");
  assertEquals(mapped.name, "ab");
  assertEquals(mapped.providerUserId, "abc-123");
});
