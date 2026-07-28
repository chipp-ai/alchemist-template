<script lang="ts">
  import { onMount } from "svelte";
  import { push } from "svelte-spa-router";
  import { authStore } from "../stores/auth.svelte";
  import { api } from "../lib/api";

  interface OAuthProviderConfig {
    id: string;
    label: string;
    color: string;
  }

  let email = $state("");
  let otpCode = $state("");
  let step = $state<1 | 2>(1);
  let isSubmitting = $state(false);
  let errorMessage = $state<string | null>(null);
  let providers = $state<OAuthProviderConfig[]>([]);
  let resendMessage = $state<string | null>(null);

  // Fetch the auth config (OAuth providers list) once on mount.
  // Use onMount, NOT $effect — see CLAUDE.md → "Stores: $effect on
  // mount is a trap; use onMount". The .then() callback writes to
  // `providers` ($state), and inside an $effect that write would
  // attribute itself as a dep, looping the fetch.
  onMount(() => {
    api.get<{
      otpEnabled: boolean;
      providers: OAuthProviderConfig[];
      googleEnabled?: boolean; // legacy field, ignored
    }>("/auth/config").then((data) => {
      providers = data.providers ?? [];
    }).catch(() => {});

    // ?autodev=1 → fire dev-login automatically. Used by alchemist-ai's
    // "Live preview" button so a fresh workspace lands the user signed
    // in without an extra click. Gated on import.meta.env.DEV (set
    // below) so a prod-built SPA ignores the param.
    if (import.meta.env.DEV && new URLSearchParams(location.search).get("autodev") === "1") {
      void handleDevLogin();
    }
  });

  async function handleSendOtp(e: Event) {
    e.preventDefault();
    if (!email.trim()) return;

    isSubmitting = true;
    errorMessage = null;

    try {
      await authStore.sendOtp(email);
      step = 2;
    } catch (err) {
      errorMessage =
        err instanceof Error ? err.message : "Failed to send code. Please try again.";
    } finally {
      isSubmitting = false;
    }
  }

  async function handleVerifyOtp(e: Event) {
    e.preventDefault();
    if (!otpCode.trim()) return;

    isSubmitting = true;
    errorMessage = null;

    try {
      await authStore.verifyOtp(email, otpCode);
      push("/");
    } catch (err) {
      errorMessage =
        err instanceof Error ? err.message : "Verification failed. Please try again.";
    } finally {
      isSubmitting = false;
    }
  }

  async function handleResend() {
    errorMessage = null;
    resendMessage = null;
    try {
      await authStore.sendOtp(email);
      resendMessage = "Code resent!";
    } catch (err) {
      errorMessage =
        err instanceof Error ? err.message : "Failed to resend code. Please try again.";
    }
  }

  function goBack() {
    step = 1;
    otpCode = "";
    errorMessage = null;
    resendMessage = null;
  }

  // Dev-only escape hatch: bypass OTP via /api/dev/login. The server
  // self-protects (`/api/dev/*` 404s in production), but we ALSO gate
  // this UI on import.meta.env.DEV so a production-built SPA never
  // ships a misleading button. Local browser testing without an SMTP
  // / inbox harness would otherwise be a wall — this is the well-lit
  // workaround.
  const isDev = import.meta.env.DEV;
  const DEV_DEFAULT_EMAIL = "dev@example.com";

  async function handleDevLogin() {
    isSubmitting = true;
    errorMessage = null;
    const targetEmail = email.trim() || DEV_DEFAULT_EMAIL;
    try {
      const res = await fetch("/api/dev/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ email: targetEmail }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`Dev login failed (${res.status}): ${body || "no body"}`);
      }
      // Refresh the store from /auth/me so the rest of the SPA sees
      // the freshly-issued session without a hard reload.
      await authStore.checkAuth();
      push("/");
    } catch (err) {
      errorMessage = err instanceof Error ? err.message : "Dev login failed";
    } finally {
      isSubmitting = false;
    }
  }
</script>

<div class="auth-page" data-testid="login-page">
  <div class="auth-card card">
    <h1 class="auth-title">Welcome back</h1>
    <p class="auth-subtitle">Sign in to your account</p>

    {#if errorMessage}
      <div class="alert alert-error" data-testid="login-alert-error">
        {errorMessage}
      </div>
    {/if}

    {#if step === 1}
      <form onsubmit={handleSendOtp} class="auth-form">
        <div class="form-field">
          <label class="label" for="login-email">Email</label>
          <input
            id="login-email"
            class="input"
            type="email"
            bind:value={email}
            placeholder="you@example.com"
            required
            autocomplete="email"
            data-testid="login-input-email"
          />
        </div>

        <button
          class="btn btn-primary auth-submit"
          type="submit"
          disabled={isSubmitting}
          data-testid="login-btn-submit"
        >
          {isSubmitting ? "Sending code..." : "Continue"}
        </button>
      </form>
    {:else}
      <p class="otp-sent-message" data-testid="login-otp-sent">
        We sent a code to <strong>{email}</strong>
      </p>

      {#if resendMessage}
        <div class="alert alert-success" data-testid="login-alert-resend">
          {resendMessage}
        </div>
      {/if}

      <form onsubmit={handleVerifyOtp} class="auth-form">
        <div class="form-field">
          <label class="label" for="login-otp">Verification code</label>
          <input
            id="login-otp"
            class="input otp-input"
            type="text"
            bind:value={otpCode}
            placeholder="000000"
            required
            maxlength="6"
            pattern="[0-9]*"
            inputmode="numeric"
            autocomplete="one-time-code"
            data-testid="login-input-otp"
          />
        </div>

        <button
          class="btn btn-primary auth-submit"
          type="submit"
          disabled={isSubmitting}
          data-testid="login-btn-verify"
        >
          {isSubmitting ? "Verifying..." : "Verify"}
        </button>
      </form>

      <div class="otp-actions">
        <button
          class="link-btn"
          type="button"
          onclick={handleResend}
          data-testid="login-btn-resend"
        >
          Resend code
        </button>
        <button
          class="link-btn"
          type="button"
          onclick={goBack}
          data-testid="login-btn-back"
        >
          Back
        </button>
      </div>
    {/if}

    {#if providers.length > 0 && step === 1}
      <div class="auth-divider">
        <span>or</span>
      </div>

      <div class="oauth-buttons">
        {#each providers as p (p.id)}
          <button
            class="btn btn-secondary oauth-btn"
            style="--provider-color: {p.color}"
            onclick={() => (window.location.href = `/api/auth/${p.id}`)}
            data-testid="login-btn-{p.id}"
          >
            {p.label}
          </button>
        {/each}
      </div>
    {/if}

    <p class="auth-footer">
      Don't have an account? <a href="#/signup" data-testid="login-link-signup">Sign up</a>
    </p>

    {#if isDev && step === 1}
      <div class="dev-login-section" data-testid="login-dev-section">
        <div class="dev-login-divider">
          <span>dev only · skips OTP email</span>
        </div>
        <button
          type="button"
          class="btn btn-secondary dev-login-btn"
          onclick={handleDevLogin}
          disabled={isSubmitting}
          data-testid="login-btn-dev"
        >
          Dev login as {email.trim() || DEV_DEFAULT_EMAIL}
        </button>
        <p class="dev-login-help">
          Local-only escape hatch: there's no SMTP harness in dev, so the
          OTP code never reaches an inbox. This calls
          <code>POST /api/dev/login</code> directly. The endpoint 404s
          when <code>NODE_ENV=production</code>, and this button is
          stripped from production SPA builds.
        </p>
      </div>
    {/if}
  </div>
</div>

<style>
  .auth-page {
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 100vh;
    padding: var(--space-lg);
    background: var(--color-surface);
  }

  .auth-card {
    width: 100%;
    max-width: 400px;
    padding: var(--space-xl);
  }

  .auth-title {
    font-size: var(--text-2xl);
    font-weight: 600;
    margin-bottom: var(--space-xs);
  }

  .auth-subtitle {
    font-size: var(--text-sm);
    color: var(--color-muted);
    margin-bottom: var(--space-lg);
  }

  .auth-form {
    display: flex;
    flex-direction: column;
    gap: var(--space-md);
  }

  .form-field {
    display: flex;
    flex-direction: column;
  }

  .auth-submit {
    width: 100%;
    margin-top: var(--space-sm);
  }

  .otp-sent-message {
    font-size: var(--text-sm);
    color: var(--color-muted);
    margin-bottom: var(--space-md);
  }

  .otp-input {
    text-align: center;
    font-size: var(--text-2xl);
    font-family: var(--font-mono);
    letter-spacing: 0.5em;
    padding: var(--space-md);
  }

  /* ── Dev login affordance ───────────────────────────────────────── */
  /* Visually distinct from the primary auth flow so it's obvious this */
  /* is a dev convenience, not the production sign-in path.            */
  .dev-login-section {
    margin-top: var(--space-lg);
    padding-top: var(--space-md);
    border-top: 1px dashed var(--color-muted);
  }
  .dev-login-divider {
    text-align: center;
    font-size: var(--text-xs);
    color: var(--color-muted);
    text-transform: uppercase;
    letter-spacing: 0.1em;
    margin-bottom: var(--space-sm);
  }
  .dev-login-btn {
    width: 100%;
  }
  .dev-login-help {
    margin-top: var(--space-xs);
    font-size: var(--text-xs);
    color: var(--color-muted);
    line-height: 1.4;
  }
  .dev-login-help code {
    font-family: var(--font-mono);
    font-size: 0.95em;
    background: var(--color-surface);
    padding: 0 0.25em;
    border-radius: 2px;
  }

  .otp-actions {
    display: flex;
    justify-content: center;
    gap: var(--space-lg);
    margin-top: var(--space-md);
  }

  .link-btn {
    background: none;
    border: none;
    color: var(--color-accent);
    cursor: pointer;
    font-size: var(--text-sm);
    padding: 0;
    text-decoration: underline;
  }

  .link-btn:hover {
    opacity: 0.8;
  }

  .auth-divider {
    display: flex;
    align-items: center;
    gap: var(--space-md);
    margin: var(--space-lg) 0;
    color: var(--color-muted);
    font-size: var(--text-sm);
  }

  .auth-divider::before,
  .auth-divider::after {
    content: "";
    flex: 1;
    height: 1px;
    background: var(--color-border);
  }

  .oauth-buttons {
    display: flex;
    flex-direction: column;
    gap: var(--space-sm);
  }

  .oauth-btn {
    width: 100%;
    border-color: color-mix(in srgb, var(--provider-color) 40%, var(--color-border));
  }
  .oauth-btn:hover {
    border-color: var(--provider-color);
  }

  .auth-footer {
    margin-top: var(--space-lg);
    text-align: center;
    font-size: var(--text-sm);
    color: var(--color-muted);
  }

  .alert {
    margin-bottom: var(--space-md);
  }
</style>
