<script lang="ts">
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

  $effect(() => {
    api.get<{
      otpEnabled: boolean;
      providers: OAuthProviderConfig[];
      googleEnabled?: boolean; // legacy field, ignored
    }>("/auth/config").then((data) => {
      providers = data.providers ?? [];
    }).catch(() => {});
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
    font-family: monospace;
    letter-spacing: 0.5em;
    padding: var(--space-md);
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
    color: var(--color-primary);
    cursor: pointer;
    font-size: var(--text-sm);
    padding: 0;
    text-decoration: underline;
  }

  .link-btn:hover {
    opacity: 0.8;
  }

  .alert-success {
    color: var(--color-success, #16a34a);
    background: var(--color-success-bg, #f0fdf4);
    border: 1px solid var(--color-success-border, #bbf7d0);
    padding: var(--space-sm) var(--space-md);
    border-radius: var(--radius-md, 6px);
    font-size: var(--text-sm);
    margin-bottom: var(--space-md);
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
