<!--
  InviteAccept page — landing for /#/invite/:token links from email.

  Two flows:
    1. Logged-out user lands here. Page fetches /api/invite/:token,
       shows org + role + inviter. User clicks "Sign in to accept",
       which routes to /signup (with the invited email pre-filled
       via sessionStorage). After OTP completes, the user lands here
       again as authenticated; the page detects that and POSTs
       /accept automatically.
    2. Logged-in user lands here (clicked an invite link while
       already signed in). Page calls /accept directly. Email
       mismatch shows a clean error and a "sign out and use the
       invited email" affordance.
-->
<script lang="ts">
  import { onMount } from "svelte";
  import { push } from "svelte-spa-router";
  import { authStore } from "../stores/auth.svelte";
  import { orgStore } from "../stores/organization.svelte";
  import { api, ApiError } from "../lib/api";
  import { roleLabel } from "../lib/permissions";

  let { params }: { params: { token?: string } } = $props();
  const token = $derived(params.token ?? "");

  interface InvitePreview {
    organizationName: string;
    role: string;
    email: string;
    invitedByName: string | null;
    invitedByEmail: string;
    expiresAt: string;
  }

  let preview = $state<InvitePreview | null>(null);
  let previewError = $state<string | null>(null);
  let isLoading = $state(true);
  let isAccepting = $state(false);
  let acceptError = $state<string | null>(null);
  let acceptSuccess = $state(false);

  // Pre-fill the OTP form with the invite's email so a logged-out
  // user doesn't have to retype it after clicking through.
  const SIGNUP_EMAIL_KEY = "invite_email";
  const SIGNUP_TOKEN_KEY = "invite_token";

  onMount(async () => {
    if (!token) {
      previewError = "No invite token in the URL.";
      isLoading = false;
      return;
    }

    try {
      const res = await api.get<{ data: InvitePreview }>(
        `/invite/${encodeURIComponent(token)}`,
      );
      preview = res.data;
    } catch (err) {
      previewError = err instanceof ApiError
        ? err.message
        : "Could not load invite.";
    } finally {
      isLoading = false;
    }
  });

  // If the user is already logged in AND their email matches the
  // invite, auto-accept on first render. We don't auto-accept on
  // mismatch — that needs an explicit user choice (sign out, then
  // sign back in with the right email).
  $effect(() => {
    if (
      preview &&
      authStore.isAuthenticated &&
      authStore.user?.email?.toLowerCase() === preview.email.toLowerCase() &&
      !acceptSuccess &&
      !isAccepting
    ) {
      acceptInvite();
    }
  });

  async function acceptInvite() {
    if (!token || isAccepting) return;
    isAccepting = true;
    acceptError = null;
    try {
      await api.post(`/invite/${encodeURIComponent(token)}/accept`);
      // Refresh the user's auth payload — the JWT cookie's
      // organizationId is now stale. Easiest reset: re-run checkAuth.
      await authStore.checkAuth();
      // And refresh org-scoped state in the store.
      await orgStore.fetchOrg();
      await orgStore.fetchMembers();
      acceptSuccess = true;
      // Clear stash so a future visit doesn't re-trigger pre-fill.
      sessionStorage.removeItem(SIGNUP_EMAIL_KEY);
      sessionStorage.removeItem(SIGNUP_TOKEN_KEY);
    } catch (err) {
      acceptError = err instanceof ApiError
        ? err.message
        : "Failed to accept invite.";
    } finally {
      isAccepting = false;
    }
  }

  function goSignIn() {
    if (preview) {
      sessionStorage.setItem(SIGNUP_EMAIL_KEY, preview.email);
      sessionStorage.setItem(SIGNUP_TOKEN_KEY, token);
    }
    push("/login");
  }

  function goSignUp() {
    if (preview) {
      sessionStorage.setItem(SIGNUP_EMAIL_KEY, preview.email);
      sessionStorage.setItem(SIGNUP_TOKEN_KEY, token);
    }
    push("/signup");
  }

  async function signOutAndRetry() {
    await authStore.logout();
    // logout sets hash to /login; let the user sign in with the right email.
  }

  function goDashboard() {
    push("/");
  }
</script>

<div class="invite-page" data-testid="invite-page">
  {#if isLoading}
    <div class="card invite-card">
      <p class="text-muted" data-testid="invite-loading">Loading invite…</p>
    </div>
  {:else if previewError}
    <div class="card invite-card" data-testid="invite-error">
      <h1 class="invite-title">Invite unavailable</h1>
      <p class="text-muted">{previewError}</p>
      <button class="btn btn-primary" onclick={() => push("/login")}>
        Go to sign in
      </button>
    </div>
  {:else if preview && acceptSuccess}
    <div class="card invite-card" data-testid="invite-success">
      <h1 class="invite-title">You're in</h1>
      <p>
        You've joined <strong>{preview.organizationName}</strong> as
        <strong>{roleLabel(preview.role)}</strong>.
      </p>
      <button class="btn btn-primary" onclick={goDashboard} data-testid="invite-btn-dashboard">
        Go to dashboard
      </button>
    </div>
  {:else if preview && authStore.isAuthenticated && authStore.user?.email?.toLowerCase() !== preview.email.toLowerCase()}
    <div class="card invite-card" data-testid="invite-email-mismatch">
      <h1 class="invite-title">Wrong email</h1>
      <p>
        This invite was sent to <strong>{preview.email}</strong>, but you're
        signed in as <strong>{authStore.user?.email}</strong>.
      </p>
      <p class="text-muted">
        Sign out and sign back in with <strong>{preview.email}</strong> to
        accept.
      </p>
      <button class="btn btn-primary" onclick={signOutAndRetry} data-testid="invite-btn-signout">
        Sign out
      </button>
    </div>
  {:else if preview}
    <div class="card invite-card" data-testid="invite-preview">
      <h1 class="invite-title">You're invited</h1>
      <p>
        <strong>{preview.invitedByName ?? preview.invitedByEmail}</strong>
        invited you to join <strong>{preview.organizationName}</strong>
        as <strong>{roleLabel(preview.role)}</strong>.
      </p>
      <p class="text-muted invite-meta">
        Invite sent to {preview.email}.
      </p>

      {#if acceptError}
        <div class="alert alert-error" data-testid="invite-accept-error">
          {acceptError}
        </div>
      {/if}

      {#if authStore.isAuthenticated}
        <button
          class="btn btn-primary"
          onclick={acceptInvite}
          disabled={isAccepting}
          data-testid="invite-btn-accept"
        >
          {isAccepting ? "Accepting…" : "Accept invite"}
        </button>
      {:else}
        <p class="text-muted">Sign in or create an account to accept.</p>
        <div class="invite-actions">
          <button class="btn btn-primary" onclick={goSignIn} data-testid="invite-btn-signin">
            Sign in
          </button>
          <button class="btn btn-secondary" onclick={goSignUp} data-testid="invite-btn-signup">
            Create account
          </button>
        </div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .invite-page {
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 100vh;
    padding: var(--space-md);
  }
  .invite-card {
    max-width: 480px;
    width: 100%;
    padding: var(--space-xl);
  }
  .invite-title {
    font-size: var(--text-xl);
    font-weight: 600;
    margin-bottom: var(--space-md);
  }
  .invite-meta {
    margin-top: var(--space-sm);
    font-size: var(--text-sm);
  }
  .invite-actions {
    display: flex;
    gap: var(--space-sm);
    margin-top: var(--space-md);
  }
  .alert {
    margin: var(--space-md) 0;
  }
</style>
