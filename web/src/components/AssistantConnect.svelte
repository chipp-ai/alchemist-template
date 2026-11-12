<script lang="ts">
  /**
   * "Use with Claude / ChatGPT / Grok": connect an AI assistant to this
   * app's MCP server (/api/mcp). Shown in Settings to every signed-in
   * member, a viewer included. Settings loads `info` from GET /api/assistants;
   * the per-client links and steps live in web/src/lib/assistant-connect.ts.
   */
  import {
    ASSISTANT_TARGETS,
    ASSISTANTS_DOCS_URL,
    type AssistantsInfo,
    type AssistantTarget,
  } from "../lib/assistant-connect";

  let { info }: { info: AssistantsInfo } = $props();

  let copiedFor = $state<string | null>(null);

  async function copy(text: string, key: string): Promise<boolean> {
    try {
      await navigator.clipboard.writeText(text);
      copiedFor = key;
      setTimeout(() => {
        if (copiedFor === key) copiedFor = null;
      }, 2500);
      return true;
    } catch {
      return false;
    }
  }

  async function connect(target: AssistantTarget) {
    if (!info.mcpUrl) return;
    const href = target.url({ name: info.appName, mcpUrl: info.mcpUrl });
    // Start the copy and the open inside the click: browsers allow both
    // only during the user's gesture.
    const copying = target.prefills ? null : copy(info.mcpUrl, target.id);
    const win = window.open(href, "_blank");
    if (win) win.opener = null;
    else window.location.href = href;
    await copying;
  }
</script>

<section class="card settings-section" data-testid="assistants-section">
  <h2 class="section-title">Use with Claude, ChatGPT or Grok</h2>

  {#if !info.enabled || !info.mcpUrl}
    <p class="text-muted" data-testid="assistants-disabled">
      Connecting AI assistants is not turned on for this app. The app's builder can turn it
      on in Chipp.
    </p>
  {:else}
    <p class="assistants-intro" data-testid="assistants-intro">
      Connect an AI assistant to {info.appName}. You sign in with your own account, so the
      assistant sees only what you can see: your organization's documents and files, the
      app's data model, and read-only data, limited by your role. A viewer can only read.
      It never sees sign-in or secret data.
      <a href={ASSISTANTS_DOCS_URL} target="_blank" rel="noopener noreferrer" data-testid="assistants-link-docs">
        How this works
      </a>
    </p>

    <div class="assistants-url" data-testid="assistants-url">
      <code class="assistants-url-value" data-testid="assistants-url-value">{info.mcpUrl}</code>
      <button
        type="button"
        class="btn btn-secondary btn-sm"
        onclick={() => info.mcpUrl && copy(info.mcpUrl, "url")}
        data-testid="assistants-btn-copy-url"
      >
        {copiedFor === "url" ? "Copied" : "Copy URL"}
      </button>
    </div>

    <div class="assistants-clients" data-testid="assistants-clients">
      {#each ASSISTANT_TARGETS as target (target.id)}
        <div class="assistants-row" data-testid="assistants-row-{target.id}">
          <div class="assistants-row-text">
            <div class="assistants-row-title">{target.label}</div>
            <div class="assistants-row-steps">
              {copiedFor === target.id ? "URL copied. " : ""}{target.steps}
            </div>
          </div>
          <button
            type="button"
            class="btn btn-secondary assistants-row-btn"
            onclick={() => connect(target)}
            data-testid="assistants-btn-{target.id}"
          >
            {target.action}
          </button>
        </div>
      {/each}
    </div>

    <p class="text-muted assistants-other" data-testid="assistants-other">
      Another MCP client: add the URL above as a remote MCP server and sign in when it asks.
    </p>
  {/if}
</section>

<style>
  .assistants-intro {
    margin: 0 0 var(--space-md);
    color: var(--color-text-secondary);
    line-height: 1.5;
  }
  .assistants-url {
    display: flex;
    align-items: center;
    gap: var(--space-sm);
    margin-bottom: var(--space-md);
    flex-wrap: wrap;
  }
  .assistants-url-value {
    font-family: var(--font-mono);
    font-size: var(--text-sm);
    padding: var(--space-sm) var(--space-sm);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    background: var(--color-surface);
    overflow-wrap: anywhere;
    flex: 1 1 16rem;
    min-width: 0;
  }
  .assistants-clients {
    display: flex;
    flex-direction: column;
  }
  .assistants-row {
    display: flex;
    align-items: center;
    gap: var(--space-md);
    padding: var(--space-md) 0;
    border-top: 1px solid var(--color-border);
  }
  .assistants-row-text {
    flex: 1 1 auto;
    min-width: 0;
  }
  .assistants-row-title {
    font-weight: 600;
    margin-bottom: var(--space-xs);
  }
  .assistants-row-steps {
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
    line-height: 1.45;
  }
  .assistants-row-btn {
    flex: 0 0 auto;
    white-space: nowrap;
  }
  @media (max-width: 560px) {
    .assistants-row {
      flex-direction: column;
      align-items: stretch;
    }
    .assistants-row-btn {
      width: 100%;
    }
  }
  .assistants-other {
    margin-top: var(--space-md);
    font-size: var(--text-sm);
  }
</style>
