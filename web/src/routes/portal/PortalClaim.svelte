<!--
  Portal claim: the landing page for an emailed /#/portal/claim/:token link.

  Frictionless by design. There is no form, no code to type, and no
  account to create: the token in the URL is the credential, so the page
  POSTs it, picks up the session cookie, and drops the user straight into
  their portal.

  The POST is fired by this page's JS on mount. That is deliberate: a mail
  client prefetching the link issues a GET, which does nothing here and
  404s server-side, so a preview scan can never sign someone in.
-->
<script lang="ts">
  import { onMount } from "svelte";
  import { replace } from "svelte-spa-router";
  import { authStore } from "../../stores/auth.svelte";
  import { api, ApiError } from "../../lib/api";
  import PortalLayout from "../../components/PortalLayout.svelte";

  let { params }: { params: { token?: string } } = $props();

  let error = $state<string | null>(null);
  let isClaiming = $state(true);

  onMount(async () => {
    const token = params.token ?? "";
    if (!token) {
      error = "This portal link is missing its token.";
      isClaiming = false;
      return;
    }

    try {
      await api.post("/portal/claim", { token }, { silent401: true });
      // The session cookie is set server-side; pick it up before routing
      // so the portal renders signed in on the first paint.
      await authStore.checkAuth();
      replace("/portal");
    } catch (err) {
      // Deliberately the same copy for invalid, revoked, and expired: the
      // server does not distinguish them either, so a prober learns
      // nothing from this page that it could not learn from the API.
      error = err instanceof ApiError && err.status !== 500
        ? err.message
        : "This portal link is invalid or has expired.";
    } finally {
      isClaiming = false;
    }
  });
</script>

<PortalLayout title="Your portal">
  {#snippet children()}
    {#if isClaiming}
      <p class="text-muted" data-testid="portal-claim-working">Signing you in…</p>
    {:else if error}
      <div class="card portal-claim-card" data-testid="portal-claim-error">
        <h1 class="portal-claim-title">This link does not work</h1>
        <p class="text-muted">{error}</p>
        <p class="text-muted">
          Ask whoever sent it to email you a new one. Links can be turned
          off, and a fresh one replaces the last.
        </p>
      </div>
    {/if}
  {/snippet}
</PortalLayout>

<style>
  .portal-claim-card {
    padding: var(--space-xl);
  }

  .portal-claim-title {
    font-family: var(--font-heading);
    font-size: var(--text-xl);
    font-weight: 600;
    margin-bottom: var(--space-sm);
  }
</style>
