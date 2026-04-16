<script lang="ts">
  import { push } from "svelte-spa-router";
  import { authStore } from "../stores/auth.svelte";
  import { api } from "../lib/api";

  let email = $state("");
  let otpCode = $state("");
  let step = $state<1 | 2>(1);
  let isSubmitting = $state(false);
  let errorMessage = $state<string | null>(null);
  let googleEnabled = $state(false);
  let resendMessage = $state<string | null>(null);

  $effect(() => {
    api.get<{ googleEnabled: boolean }>("/auth/config").then((data) => {
      googleEnabled = data.googleEnabled;
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

    {#if googleEnabled && step === 1}
      <div class="auth-divider">
        <span>or</span>
      </div>

      <button
        class="btn btn-secondary auth-google"
        onclick={() => (window.location.href = "/api/auth/google")}
        data-testid="login-btn-google"
      >
        <svg width="18" height="18" viewBox="0 0 24 24">
          <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4"/>
          <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
          <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
          <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
        </svg>
        Continue with Google
      </button>
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

  .auth-google {
    width: 100%;
    gap: var(--space-sm);
  }

  .auth-google svg {
    flex-shrink: 0;
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
