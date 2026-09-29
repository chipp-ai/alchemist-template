/**
 * MCP OAuth 2.1 Authorization Server endpoints (public, no auth middleware
 * except where noted).
 *
 * Mounted at /api/mcp/oauth. Lets OAuth-only remote-MCP hosts (claude.ai
 * custom connectors, ChatGPT, Claude Code, IDE clients) connect to the MCP
 * server at /api/mcp -- those connector UIs speak OAuth 2.1 + PKCE + Dynamic
 * Client Registration and have no field for a static API key.
 *
 *   GET  /authorize -- validate params; render server-side consent
 *                      (logged-in) or a server-rendered email-OTP login
 *                      (this template is headless -- no SPA to bounce to).
 *   POST /authorize -- process approve/deny; issue a PKCE-bound auth code.
 *   POST /token     -- authorization_code | refresh_token grant.
 *   POST /register  -- RFC 7591 Dynamic Client Registration (public clients).
 *   POST /revoke    -- RFC 7009 token revocation.
 *
 * The browser carries the session_id cookie (JWT) on the top-level GET
 * (SameSite=Lax permits it), so consent gates on that session. The login
 * page posts to the EXISTING /api/auth/send-otp + /verify-otp endpoints
 * (same origin) and reloads -- no duplicate auth implementation.
 *
 * The base template's chippInsightsMiddleware (src/api/middleware/
 * chipp-insights.ts) injects the Chipp Insights beacon into every HTML
 * response, these pages included, when the project has a
 * chipp-insights.json. The login page's verify-otp success handler fires
 * `window.chippInsights?.identify(email)`, since this is the only
 * "successful login" moment the MCP surface has in a browser.
 *
 * Modeled on the Alchemist platform's own MCP OAuth server.
 */

import { Hono } from "hono";
import type { Context } from "hono";
import { authMiddleware, type AuthUser } from "@/api/middleware/auth.ts";
import { escapeHtml as escapeHtmlText } from "@/lib/safe-html.ts";
import { log } from "@/lib/logger.ts";
import { BRAND } from "@/config/brand.ts";
import {
  authCodeService,
  clientService,
  isRedirectUriAllowed,
  normalizeMcpScopes,
  oauthTokenService,
  parseStringArray,
} from "@/services/mcp-oauth/service.ts";

const mcpOauthRoutes = new Hono();

function sessionUser(c: Context): AuthUser | null {
  return (c.get("user") as AuthUser | undefined) ?? null;
}

// ── GET /authorize ───────────────────────────────────────────────────────────

mcpOauthRoutes.get("/authorize", authMiddleware, async (c) => {
  const clientId = c.req.query("client_id");
  const redirectUri = c.req.query("redirect_uri");
  const responseType = c.req.query("response_type");
  const codeChallenge = c.req.query("code_challenge");
  const codeChallengeMethod = c.req.query("code_challenge_method") ?? "S256";
  const scope = c.req.query("scope") ?? "";
  const state = c.req.query("state") ?? "";

  if (!clientId || !redirectUri || responseType !== "code" || !codeChallenge) {
    return c.json(
      {
        error: "invalid_request",
        error_description:
          "Missing required parameters: client_id, redirect_uri, response_type=code, code_challenge",
      },
      400,
    );
  }
  if (codeChallengeMethod !== "S256") {
    return c.json(
      { error: "invalid_request", error_description: "Only S256 code_challenge_method is supported" },
      400,
    );
  }

  const client = await clientService.getActive(clientId);
  if (!client) {
    return c.json({ error: "invalid_client", error_description: "Unknown client_id" }, 400);
  }
  if (!isRedirectUriAllowed(redirectUri, parseStringArray(client.redirectUris))) {
    return c.json(
      { error: "invalid_request", error_description: "redirect_uri not registered for this client" },
      400,
    );
  }

  // Headless template: no SPA login to bounce to. Render a server-side
  // email-OTP login that reuses /api/auth/send-otp + /verify-otp, then
  // reloads this same authorize URL (all params preserved) to show consent.
  const user = sessionUser(c);
  if (!user) {
    return c.html(renderLoginPage(escapeHtmlText(client.name)));
  }

  return c.html(
    renderConsentPage({
      clientName: escapeHtmlText(client.name),
      clientDescription: client.description ? escapeHtmlText(client.description) : null,
      userEmail: escapeHtmlText(user.email),
      clientId,
      redirectUri,
      scope,
      state,
      codeChallenge,
      codeChallengeMethod,
    }),
  );
});

// ── POST /authorize (consent decision) ───────────────────────────────────────

mcpOauthRoutes.post("/authorize", authMiddleware, async (c) => {
  const user = sessionUser(c);
  if (!user) {
    return c.json({ error: "access_denied", error_description: "Not authenticated" }, 401);
  }

  const form = await c.req.parseBody();
  const get = (k: string) => (typeof form[k] === "string" ? (form[k] as string) : "");
  const action = get("action");
  const clientId = get("client_id");
  const redirectUri = get("redirect_uri");
  const scope = get("scope");
  const state = get("state");
  const codeChallenge = get("code_challenge");
  const codeChallengeMethod = get("code_challenge_method") || "S256";

  // Validate client + redirect_uri BEFORE acting on the decision (prevents
  // an open redirect on deny).
  const client = await clientService.getActive(clientId);
  if (!client) return c.json({ error: "invalid_client" }, 400);
  if (!isRedirectUriAllowed(redirectUri, parseStringArray(client.redirectUris))) {
    return c.json({ error: "invalid_request", error_description: "Invalid redirect_uri" }, 400);
  }

  if (action === "deny") {
    const denyUrl = new URL(redirectUri);
    denyUrl.searchParams.set("error", "access_denied");
    if (state) denyUrl.searchParams.set("state", state);
    return c.redirect(denyUrl.toString());
  }
  if (action !== "approve") {
    return c.json({ error: "invalid_request", error_description: "action must be approve or deny" }, 400);
  }

  const code = await authCodeService.create({
    userId: user.id,
    clientId,
    redirectUri,
    scopes: normalizeMcpScopes(scope),
    codeChallenge,
    codeChallengeMethod,
  });

  const callbackUrl = new URL(redirectUri);
  callbackUrl.searchParams.set("code", code);
  if (state) callbackUrl.searchParams.set("state", state);

  log.info("MCP OAuth auth code issued", {
    source: "mcp-oauth",
    userId: user.id,
    clientId,
  });

  return c.redirect(callbackUrl.toString());
});

// ── POST /token ───────────────────────────────────────────────────────────────

mcpOauthRoutes.post("/token", async (c) => {
  const body = await readBody(c);
  const grantType = body.grant_type;

  if (grantType === "authorization_code") {
    const { code, client_id: clientId, redirect_uri: redirectUri, code_verifier: verifier } = body;
    if (!code || !clientId || !redirectUri || !verifier) {
      return c.json(
        { error: "invalid_request", error_description: "Missing code, client_id, redirect_uri, or code_verifier" },
        400,
      );
    }

    const authCode = await authCodeService.consume(code);
    if (!authCode) {
      return c.json(
        { error: "invalid_grant", error_description: "Invalid, expired, or already-used authorization code" },
        400,
      );
    }
    if (authCode.clientId !== clientId) {
      return c.json({ error: "invalid_grant", error_description: "client_id mismatch" }, 400);
    }
    if (authCode.redirectUri !== redirectUri) {
      return c.json({ error: "invalid_grant", error_description: "redirect_uri mismatch" }, 400);
    }
    if (!authCodeService.verifyPkce(verifier, authCode.codeChallenge, authCode.codeChallengeMethod)) {
      return c.json({ error: "invalid_grant", error_description: "PKCE verification failed" }, 400);
    }

    const tokens = await oauthTokenService.issueTokens({
      userId: authCode.userId,
      clientId,
      scopes: authCode.scopes,
      userAgent: c.req.header("user-agent") ?? null,
      ipAddress: c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    });
    return c.json(tokenResponse(tokens));
  }

  if (grantType === "refresh_token") {
    const { refresh_token: refreshToken, client_id: clientId } = body;
    if (!refreshToken || !clientId) {
      return c.json(
        { error: "invalid_request", error_description: "Missing refresh_token or client_id" },
        400,
      );
    }
    const tokens = await oauthTokenService.refreshTokens(refreshToken, clientId);
    if (!tokens) {
      return c.json({ error: "invalid_grant", error_description: "Invalid or expired refresh token" }, 400);
    }
    return c.json(tokenResponse(tokens));
  }

  return c.json(
    { error: "unsupported_grant_type", error_description: "Supported: authorization_code, refresh_token" },
    400,
  );
});

// ── POST /register (RFC 7591 Dynamic Client Registration) ────────────────────

mcpOauthRoutes.post("/register", async (c) => {
  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_client_metadata", error_description: "Body must be JSON" }, 400);
  }

  const redirectUris = body.redirect_uris;
  if (!Array.isArray(redirectUris) || redirectUris.length === 0) {
    return c.json(
      { error: "invalid_client_metadata", error_description: "redirect_uris is required (non-empty array)" },
      400,
    );
  }

  for (const uri of redirectUris) {
    if (typeof uri !== "string") {
      return c.json({ error: "invalid_client_metadata", error_description: "redirect_uris must be strings" }, 400);
    }
    try {
      const parsed = new URL(uri);
      if (
        parsed.hostname !== "localhost" &&
        parsed.hostname !== "127.0.0.1" &&
        parsed.protocol !== "https:"
      ) {
        return c.json(
          {
            error: "invalid_client_metadata",
            error_description: `redirect_uri must use HTTPS for non-localhost: ${uri}`,
          },
          400,
        );
      }
    } catch {
      return c.json({ error: "invalid_client_metadata", error_description: `Invalid redirect_uri: ${uri}` }, 400);
    }
  }

  const clientName = typeof body.client_name === "string" ? body.client_name : null;
  const { clientId, issuedAtSeconds } = await clientService.register({
    redirectUris: redirectUris as string[],
    clientName,
  });

  return c.json(
    {
      client_id: clientId,
      client_id_issued_at: issuedAtSeconds,
      redirect_uris: redirectUris,
      client_name: clientName ?? clientId,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    },
    201,
  );
});

// ── POST /revoke (RFC 7009) ──────────────────────────────────────────────────

mcpOauthRoutes.post("/revoke", async (c) => {
  const body = await readBody(c);
  // Per RFC 7009 always return 200 (no info leakage), even for a missing token.
  if (body.token) await oauthTokenService.revokeToken(body.token);
  return c.json({});
});

// ── Helpers ───────────────────────────────────────────────────────────────────

async function readBody(c: Context): Promise<Record<string, string>> {
  const contentType = c.req.header("content-type") ?? "";
  if (contentType.includes("application/json")) {
    try {
      return await c.req.json();
    } catch {
      return {};
    }
  }
  const form = await c.req.parseBody();
  return Object.fromEntries(
    Object.entries(form).map(([k, v]) => [k, String(v)]),
  );
}

function tokenResponse(t: { accessToken: string; refreshToken: string; expiresIn: number; scope: string }) {
  return {
    access_token: t.accessToken,
    token_type: "Bearer",
    expires_in: t.expiresIn,
    refresh_token: t.refreshToken,
    scope: t.scope,
  };
}

// ── Server-rendered pages ─────────────────────────────────────────────────────

const PAGE_STYLE = `
  :root { color-scheme: light dark; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: #0b0b0f; color: #e8e8ec; margin: 0; display: grid; place-items: center; min-height: 100vh; }
  .card { background: #16161c; border: 1px solid #2a2a33; border-radius: 16px; padding: 32px;
    max-width: 420px; width: calc(100% - 48px); box-shadow: 0 12px 40px rgba(0,0,0,.4); }
  h1 { font-size: 20px; margin: 0 0 4px; }
  p { color: #a0a0aa; font-size: 14px; line-height: 1.5; margin: 8px 0; }
  .who { font-size: 13px; color: #8a8a94; margin-bottom: 20px; }
  .scopes { background: #0f0f14; border: 1px solid #24242c; border-radius: 10px; padding: 12px 16px;
    font-size: 13px; color: #c8c8d0; margin: 16px 0; }
  .row { display: flex; gap: 12px; margin-top: 24px; }
  button { flex: 1; padding: 12px; border-radius: 10px; border: none; font-size: 15px; font-weight: 600;
    cursor: pointer; }
  .approve { background: #6d5efc; color: #fff; }
  .deny { background: transparent; color: #c8c8d0; border: 1px solid #2a2a33; }
  input { width: 100%; box-sizing: border-box; padding: 12px; border-radius: 10px; margin: 6px 0 12px;
    border: 1px solid #2a2a33; background: #0f0f14; color: #e8e8ec; font-size: 15px; }
  .error { color: #ff7a7a; font-size: 13px; min-height: 18px; margin: 0; }
  .hidden { display: none; }
`;

interface ConsentParams {
  clientName: string;
  clientDescription: string | null;
  userEmail: string;
  clientId: string;
  redirectUri: string;
  scope: string;
  state: string;
  codeChallenge: string;
  codeChallengeMethod: string;
}

/** Hidden form field -- values are server-supplied/validated, but escape anyway. */
function hidden(name: string, value: string): string {
  return `<input type="hidden" name="${name}" value="${escapeHtmlText(value)}">`;
}

function renderConsentPage(p: ConsentParams): string {
  const brand = escapeHtmlText(BRAND.name);
  const desc = p.clientDescription ? `<p>${p.clientDescription}</p>` : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Authorize ${p.clientName} — ${brand}</title><style>${PAGE_STYLE}</style>
</head>
<body><div class="card">
<h1>Connect ${p.clientName}</h1>
${desc}
<p>${p.clientName} is requesting access to your ${brand} account through the MCP server.</p>
<div class="scopes">It will be able to use the ${brand} MCP tools on your behalf.</div>
<p class="who">Signed in as <strong>${p.userEmail}</strong></p>
<form method="post" action="/api/mcp/oauth/authorize">
${hidden("client_id", p.clientId)}
${hidden("redirect_uri", p.redirectUri)}
${hidden("scope", p.scope)}
${hidden("state", p.state)}
${hidden("code_challenge", p.codeChallenge)}
${hidden("code_challenge_method", p.codeChallengeMethod)}
<div class="row">
<button class="deny" type="submit" name="action" value="deny">Deny</button>
<button class="approve" type="submit" name="action" value="approve">Approve</button>
</div>
</form>
</div></body></html>`;
}

/**
 * Server-rendered email-OTP login. Reuses the existing JSON endpoints
 * (/api/auth/send-otp, /api/auth/verify-otp -- verify sets the session
 * cookie), then reloads the authorize URL so consent renders. No inline
 * user-controlled values are interpolated into the script.
 */
function renderLoginPage(clientName: string): string {
  const brand = escapeHtmlText(BRAND.name);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign in — ${brand}</title><style>${PAGE_STYLE}</style>
</head>
<body><div class="card">
<h1>Sign in to continue</h1>
<p>To connect <strong>${clientName}</strong> to ${brand}, verify your email. We'll send you a
6-digit code.</p>
<div id="step-email">
<label for="email">Email</label>
<input id="email" type="email" autocomplete="email" placeholder="you@example.com" autofocus>
<p class="error" id="email-error"></p>
<div class="row"><button class="approve" id="send-btn" type="button">Send code</button></div>
</div>
<div id="step-code" class="hidden">
<label for="code">Verification code</label>
<input id="code" inputmode="numeric" autocomplete="one-time-code" placeholder="123456" maxlength="6">
<p class="error" id="code-error"></p>
<div class="row"><button class="approve" id="verify-btn" type="button">Verify &amp; continue</button></div>
</div>
<script>
(function () {
  var emailEl = document.getElementById("email");
  var codeEl = document.getElementById("code");
  function show(id) { document.getElementById(id).classList.remove("hidden"); }
  function hide(id) { document.getElementById(id).classList.add("hidden"); }
  function err(id, msg) { document.getElementById(id).textContent = msg; }
  async function post(path, body) {
    var res = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      var data = await res.json().catch(function () { return {}; });
      throw new Error(data.error || "Request failed");
    }
  }
  document.getElementById("send-btn").addEventListener("click", async function () {
    err("email-error", "");
    try {
      await post("/api/auth/send-otp", { email: emailEl.value.trim().toLowerCase() });
      hide("step-email"); show("step-code"); codeEl.focus();
    } catch (e) { err("email-error", e.message); }
  });
  document.getElementById("verify-btn").addEventListener("click", async function () {
    err("code-error", "");
    try {
      var loginEmail = emailEl.value.trim().toLowerCase();
      await post("/api/auth/verify-otp", {
        email: loginEmail,
        otpCode: codeEl.value.trim(),
      });
      if (window.chippInsights && window.chippInsights.identify) {
        window.chippInsights.identify(loginEmail);
      }
      location.reload();
    } catch (e) { err("code-error", e.message); }
  });
})();
</script>
</div></body></html>`;
}

export { mcpOauthRoutes };
