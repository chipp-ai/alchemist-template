<!--
  Portal home: what an END USER sees at /#/portal.

  Its ONLY data source is GET /api/portal/me, which is scoped to the
  signed-in user's own bindings server-side. Do not widen this page with
  an org-scoped read "just to show a bit of context": the whole value of
  the lane is that a portal session cannot see anyone else's record.

  Adapt the "Your records" block below to render your domain. The
  subjectType / subjectId pair identifies the record an admin bound the
  link to; join it against your own table and show the real thing.

  Signed out is a first-class state here, not a redirect to the admin
  login. A portal user whose session lapsed needs a new link, not a
  workspace sign-in form.
-->
<script lang="ts">
  import { onMount } from "svelte";
  import { authStore } from "../../stores/auth.svelte";
  import { api, ApiError } from "../../lib/api";
  import PortalLayout from "../../components/PortalLayout.svelte";

  interface PortalSubject {
    id: string;
    subjectType: string;
    subjectId: string;
    lastUsedAt: string | null;
  }

  let subjects = $state<PortalSubject[]>([]);
  let isLoading = $state(true);
  let loadError = $state<string | null>(null);

  onMount(async () => {
    if (!authStore.isAuthenticated) {
      isLoading = false;
      return;
    }
    try {
      const res = await api.get<{ data: { subjects: PortalSubject[] } }>(
        "/portal/me",
        // A lapsed portal session must render the "ask for a new link"
        // state, not bounce the user to the admin login form.
        { silent401: true },
      );
      subjects = res.data.subjects;
    } catch (err) {
      if (!(err instanceof ApiError && err.status === 401)) {
        loadError = err instanceof ApiError ? err.message : "Could not load your portal.";
      }
    } finally {
      isLoading = false;
    }
  });
</script>

<PortalLayout>
  {#snippet children()}
    {#if isLoading}
      <p class="text-muted" data-testid="portal-loading">Loading your portal…</p>
    {:else if !authStore.isAuthenticated}
      <div class="card portal-card" data-testid="portal-signed-out">
        <h1 class="portal-title">This link has expired</h1>
        <p class="text-muted">
          Portal links are personal and can be turned off at any time. Ask
          whoever sent yours to email a new one.
        </p>
      </div>
    {:else if loadError}
      <div class="alert alert-error" data-testid="portal-error">{loadError}</div>
    {:else}
      <div class="card portal-card" data-testid="portal-home">
        <h1 class="portal-title">
          Welcome{authStore.user?.name ? `, ${authStore.user.name}` : ""}
        </h1>
        <p class="text-muted">
          This is your personal view. Only you can see it.
        </p>

        {#if subjects.length === 0}
          <p class="text-muted portal-empty" data-testid="portal-empty">
            Nothing is shared with you yet.
          </p>
        {:else}
          <ul class="portal-subjects" data-testid="portal-subjects">
            {#each subjects as subject (subject.id)}
              <li class="portal-subject" data-testid="portal-subject-row">
                <!--
                  ADAPT ME: join subjectType / subjectId against your own
                  table and render the record, not its identifiers.
                -->
                <span class="portal-subject-type">{subject.subjectType}</span>
                <span class="portal-subject-id">{subject.subjectId}</span>
              </li>
            {/each}
          </ul>
        {/if}
      </div>
    {/if}
  {/snippet}
</PortalLayout>

<style>
  .portal-card {
    padding: var(--space-xl);
  }

  .portal-title {
    font-family: var(--font-heading);
    font-size: var(--text-xl);
    font-weight: 600;
    margin-bottom: var(--space-sm);
  }

  .portal-empty {
    margin-top: var(--space-lg);
  }

  .portal-subjects {
    list-style: none;
    margin: var(--space-lg) 0 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-sm);
  }

  .portal-subject {
    display: flex;
    align-items: baseline;
    gap: var(--space-sm);
    padding: var(--space-md);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    background: var(--color-surface-raised);
  }

  .portal-subject-type {
    font-size: var(--text-sm);
    font-weight: 600;
    color: var(--color-text);
  }

  .portal-subject-id {
    font-family: var(--font-mono);
    font-size: var(--text-sm);
    color: var(--color-muted);
  }
</style>
