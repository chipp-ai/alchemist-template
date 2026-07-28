<script lang="ts">
  import { onMount } from "svelte";
  import { push } from "svelte-spa-router";
  import { api } from "../lib/api";

  // svelte-spa-router passes matched route params via the `params` prop.
  // `/docs/:slug` deep-links to a page; `/docs` shows the first page.
  let { params }: { params?: { slug?: string } } = $props();

  type TocPage = { slug: string; title: string; group: string; summary: string };
  type SearchResult = {
    slug: string;
    title: string;
    heading: string;
    snippet: string;
    score: number;
    mode: "semantic" | "keyword";
  };
  type DocPage = TocPage & { body: string };

  let pages = $state<TocPage[]>([]);
  let current = $state<DocPage | null>(null);
  let loadingPage = $state(false);

  let query = $state("");
  let results = $state<SearchResult[]>([]);
  let searching = $state(false);
  let searched = $state(false);
  let searchMode = $state<"semantic" | "keyword" | null>(null);

  // Group the TOC by `group`, preserving registry order.
  const grouped = $derived.by(() => {
    const out: { group: string; pages: TocPage[] }[] = [];
    for (const p of pages) {
      let g = out.find((x) => x.group === p.group);
      if (!g) {
        g = { group: p.group, pages: [] };
        out.push(g);
      }
      g.pages.push(p);
    }
    return out;
  });

  onMount(async () => {
    try {
      const data = await api.get<{ pages: TocPage[] }>("/docs");
      pages = data.pages;
      const wanted = params?.slug ?? pages[0]?.slug;
      if (wanted) await openPage(wanted);
    } catch {
      // requireAuth redirect handles 401; nothing else to do here.
    }
  });

  async function openPage(slug: string) {
    loadingPage = true;
    try {
      const data = await api.get<{ page: DocPage }>(`/docs/${slug}`);
      current = data.page;
      push(`/docs/${slug}`);
      globalThis.scrollTo?.({ top: 0 });
    } finally {
      loadingPage = false;
    }
  }

  let debounce: ReturnType<typeof setTimeout> | undefined;
  function onQueryInput() {
    clearTimeout(debounce);
    const q = query.trim();
    if (!q) {
      results = [];
      searched = false;
      searchMode = null;
      return;
    }
    debounce = setTimeout(runSearch, 220);
  }

  async function runSearch() {
    const q = query.trim();
    if (!q) return;
    searching = true;
    try {
      const data = await api.get<{ results: SearchResult[] }>(
        `/docs/search?q=${encodeURIComponent(q)}`,
      );
      results = data.results;
      searched = true;
      searchMode = results[0]?.mode ?? null;
    } finally {
      searching = false;
    }
  }

  function clearSearch() {
    query = "";
    results = [];
    searched = false;
    searchMode = null;
  }

  // ── Compact markdown renderer (trusted, team-authored content) ──
  // Covers the constructs our docs use: fenced code, headings, lists,
  // bold, inline code, links, paragraphs, rules. HTML is escaped first,
  // so raw tags in a doc render as text rather than injecting markup.
  function escapeHtml(s: string): string {
    return s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function inline(s: string): string {
    return s
      .replace(/`([^`]+)`/g, (_m, c) => `<code>${c}</code>`)
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(
        /\[([^\]]+)\]\(([^)]+)\)/g,
        (_m, t, href) => `<a href="${href}">${t}</a>`,
      );
  }

  function renderMarkdown(md: string): string {
    const src = escapeHtml(md);
    const lines = src.split("\n");
    const html: string[] = [];
    let i = 0;
    let para: string[] = [];
    let list: { type: "ul" | "ol"; items: string[] } | null = null;

    const flushPara = () => {
      if (para.length) {
        html.push(`<p>${inline(para.join(" "))}</p>`);
        para = [];
      }
    };
    const flushList = () => {
      if (list) {
        const inner = list.items.map((it) => `<li>${inline(it)}</li>`).join("");
        html.push(`<${list.type}>${inner}</${list.type}>`);
        list = null;
      }
    };

    while (i < lines.length) {
      const line = lines[i];
      // Fenced code block.
      if (/^```/.test(line.trim())) {
        flushPara();
        flushList();
        const code: string[] = [];
        i++;
        while (i < lines.length && !/^```/.test(lines[i].trim())) {
          code.push(lines[i]);
          i++;
        }
        i++; // skip closing fence
        html.push(`<pre><code>${code.join("\n")}</code></pre>`);
        continue;
      }
      const heading = line.match(/^(#{1,6})\s+(.*\S)\s*$/);
      if (heading) {
        flushPara();
        flushList();
        const level = heading[1].length;
        html.push(`<h${level}>${inline(heading[2])}</h${level}>`);
        i++;
        continue;
      }
      if (/^\s*(-|\*)\s+/.test(line)) {
        flushPara();
        if (!list || list.type !== "ul") {
          flushList();
          list = { type: "ul", items: [] };
        }
        list.items.push(line.replace(/^\s*(-|\*)\s+/, ""));
        i++;
        continue;
      }
      if (/^\s*\d+\.\s+/.test(line)) {
        flushPara();
        if (!list || list.type !== "ol") {
          flushList();
          list = { type: "ol", items: [] };
        }
        list.items.push(line.replace(/^\s*\d+\.\s+/, ""));
        i++;
        continue;
      }
      if (/^\s*---\s*$/.test(line)) {
        flushPara();
        flushList();
        html.push("<hr />");
        i++;
        continue;
      }
      if (line.trim() === "") {
        flushPara();
        flushList();
        i++;
        continue;
      }
      para.push(line.trim());
      i++;
    }
    flushPara();
    flushList();
    return html.join("\n");
  }

  const bodyHtml = $derived(current ? renderMarkdown(current.body) : "");
</script>

<div class="docs" data-testid="docs-page">
  <aside class="toc">
    <div class="search">
      <input
        type="search"
        placeholder="Search docs…"
        bind:value={query}
        oninput={onQueryInput}
        data-testid="docs-search-input"
        aria-label="Search docs"
      />
      {#if query}
        <button class="clear" onclick={clearSearch} aria-label="Clear search">×</button>
      {/if}
    </div>

    {#if searched}
      <div class="results" data-testid="docs-search-results">
        <div class="results-head">
          {#if searching}
            Searching…
          {:else}
            {results.length} result{results.length === 1 ? "" : "s"}
            {#if searchMode === "keyword"}<span class="mode">keyword</span>{/if}
          {/if}
        </div>
        {#each results as r}
          <button class="result" onclick={() => openPage(r.slug)}>
            <div class="result-title">{r.title}</div>
            {#if r.heading && r.heading !== r.title}
              <div class="result-heading">{r.heading}</div>
            {/if}
            <div class="result-snippet">{r.snippet}</div>
          </button>
        {:else}
          {#if !searching}<div class="empty">No matches.</div>{/if}
        {/each}
      </div>
    {:else}
      {#each grouped as g}
        <div class="toc-group">
          <div class="toc-group-title">{g.group}</div>
          {#each g.pages as p}
            <button
              class="toc-item"
              class:active={current?.slug === p.slug}
              onclick={() => openPage(p.slug)}
            >
              {p.title}
            </button>
          {/each}
        </div>
      {/each}
    {/if}
  </aside>

  <article class="content">
    {#if loadingPage}
      <div class="empty">Loading…</div>
    {:else if current}
      <!-- Trusted, team-authored markdown (shipped in the image), escaped then rendered. -->
      {@html bodyHtml}
    {:else}
      <div class="empty">Select a page.</div>
    {/if}
  </article>
</div>

<style>
  .docs {
    display: grid;
    grid-template-columns: 280px 1fr;
    gap: 2rem;
    max-width: 1100px;
    margin: 0 auto;
  }
  .toc {
    position: sticky;
    top: 1rem;
    align-self: start;
    max-height: calc(100vh - 2rem);
    overflow-y: auto;
  }
  .search {
    position: relative;
    margin-bottom: 1rem;
  }
  .search input {
    width: 100%;
    padding: 0.55rem 2rem 0.55rem 0.75rem;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    font-size: 0.9rem;
  }
  .search .clear {
    position: absolute;
    right: 0.4rem;
    top: 50%;
    transform: translateY(-50%);
    border: none;
    background: none;
    font-size: 1.2rem;
    line-height: 1;
    cursor: pointer;
    color: var(--color-muted);
  }
  .toc-group { margin-bottom: 1rem; }
  .toc-group-title {
    font-size: 0.72rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--color-muted);
    margin: 0 0 0.35rem 0.25rem;
  }
  .toc-item {
    display: block;
    width: 100%;
    text-align: left;
    padding: 0.4rem 0.5rem;
    border: none;
    background: none;
    border-radius: var(--radius-sm);
    cursor: pointer;
    font-size: 0.9rem;
    color: var(--color-text);
  }
  .toc-item:hover { background: var(--color-surface); }
  .toc-item.active {
    background: var(--color-accent-subtle);
    color: var(--color-accent);
    font-weight: 600;
  }
  .results-head {
    font-size: 0.78rem;
    color: var(--color-muted);
    margin-bottom: 0.5rem;
  }
  .mode {
    margin-left: 0.4rem;
    padding: 0.05rem 0.35rem;
    border-radius: var(--radius-sm);
    background: var(--color-surface);
  }
  .result {
    display: block;
    width: 100%;
    text-align: left;
    padding: 0.55rem 0.6rem;
    margin-bottom: 0.4rem;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    background: none;
    cursor: pointer;
  }
  .result:hover { border-color: var(--color-accent); }
  .result-title { font-weight: 600; font-size: 0.88rem; }
  .result-heading { font-size: 0.78rem; color: var(--color-accent); }
  .result-snippet {
    font-size: 0.8rem;
    color: var(--color-muted);
    margin-top: 0.2rem;
  }
  .empty { color: var(--color-muted); padding: 2rem 0; }
  .content {
    min-width: 0;
    line-height: 1.65;
  }
  .content :global(h1) { font-size: 1.7rem; margin: 0 0 1rem; }
  .content :global(h2) { font-size: 1.3rem; margin: 1.8rem 0 0.6rem; }
  .content :global(h3) { font-size: 1.05rem; margin: 1.4rem 0 0.5rem; }
  .content :global(p) { margin: 0.6rem 0; }
  .content :global(ul), .content :global(ol) { margin: 0.6rem 0 0.6rem 1.4rem; }
  .content :global(li) { margin: 0.25rem 0; }
  .content :global(code) {
    background: var(--color-surface);
    padding: 0.1rem 0.3rem;
    border-radius: var(--radius-sm);
    font-size: 0.85em;
  }
  .content :global(pre) {
    background: var(--color-text);
    color: var(--color-bg);
    padding: 1rem;
    border-radius: var(--radius-md);
    overflow-x: auto;
  }
  .content :global(pre code) { background: none; padding: 0; color: inherit; }
  .content :global(a) { color: var(--color-accent); }
  @media (max-width: 720px) {
    .docs { grid-template-columns: 1fr; }
  }
</style>
