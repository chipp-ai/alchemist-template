<script lang="ts">
  /**
   * /#/design — the design system sheet.
   *
   * Every component the template ships, rendered once, driven live by the
   * DesignConfig in the control rail. The builder (or the agent, through
   * the platform chat) picks a preset, swaps fonts from the curated
   * catalog, adjusts colours and shape, and sees every component update
   * at once. "Save to project" writes web/src/design/design.json through
   * the dev API (local only); "Copy JSON" works anywhere.
   *
   * This page is the FIRST step of customising a factory project: it is
   * where "looks like the template" stops.
   */
  import { onMount } from "svelte";
  import Modal from "../components/Modal.svelte";
  import { api } from "../lib/api";
  import savedDesignJson from "../design/design.json";
  import type { DesignConfig, DesignMode } from "../design/types";
  import {
    DENSITIES,
    HEADING_CASES,
    RADIUS_PRESETS,
    SHADOW_PRESETS,
    TYPE_SCALES,
  } from "../design/types";
  import { DESIGN_PRESETS, findPreset } from "../design/presets";
  import { FONT_CATALOG, FONT_CATEGORY_LABELS, findFont, fontsByCategory, type FontCategory } from "../design/fonts";
  import { bestTextOn, contrastRatio, designToCssVars, hasErrors, validateDesign } from "../design/tokens";
  import { applyDesign, loadFontSpecimen } from "../design/apply";

  const IS_DEV = import.meta.env.DEV;

  const savedDesign = savedDesignJson as DesignConfig;
  let design = $state<DesignConfig>(structuredClone(savedDesign));
  let baseline = $state<DesignConfig>(structuredClone(savedDesign));

  let saveState = $state<"idle" | "saving" | "saved" | "error">("idle");
  let saveMessage = $state("");
  let copied = $state(false);
  let modalOpen = $state(false);
  let browsing = $state<null | "heading" | "body" | "mono">(null);
  let switchOn = $state(true);
  let activeTab = $state("overview");

  const issues = $derived(validateDesign(design));
  const blocked = $derived(hasErrors(issues));
  const dirty = $derived(JSON.stringify(design) !== JSON.stringify(baseline));
  const vars = $derived(designToCssVars(design));
  const json = $derived(JSON.stringify(design, null, 2));

  // Live preview: re-apply on every change. This effect intentionally
  // reads `design` (that IS the dependency) and only writes to the DOM.
  $effect(() => {
    applyDesign(design);
  });

  onMount(async () => {
    if (!IS_DEV) return;
    // The bundled JSON may be stale relative to disk (an agent edited the
    // file since the last build); prefer the server's copy in dev.
    try {
      const res = await api.get<{ data: { design: DesignConfig } }>("/dev/design");
      design = structuredClone(res.data.design);
      baseline = structuredClone(res.data.design);
    } catch {
      // Not running with dev routes; the bundled copy is fine.
    }
  });

  function applyPreset(id: string) {
    const preset = findPreset(id);
    if (!preset) return;
    design = structuredClone(preset.design);
  }

  function markCustom() {
    if (design.preset !== null) {
      design.preset = null;
      if (findPreset(design.name.toLowerCase())) design.name = "Custom";
    }
  }

  function setMode(mode: DesignMode) {
    design.mode = mode;
    markCustom();
  }

  async function save() {
    if (blocked) return;
    saveState = "saving";
    try {
      await api.put("/dev/design", design);
      baseline = structuredClone(design);
      saveState = "saved";
      saveMessage = "Saved to web/src/design/design.json";
      setTimeout(() => (saveState = "idle"), 2500);
    } catch (err) {
      saveState = "error";
      saveMessage = err instanceof Error ? err.message : "Save failed";
    }
  }

  async function copyJson() {
    try {
      await navigator.clipboard.writeText(json);
      copied = true;
      setTimeout(() => (copied = false), 1500);
    } catch {
      copied = false;
    }
  }

  function reset() {
    design = structuredClone(baseline);
  }

  function openBrowser(slot: "heading" | "body" | "mono") {
    browsing = slot;
    const cats: FontCategory[] = slot === "mono" ? ["mono"] : ["sans", "serif", "display"];
    for (const cat of cats) {
      for (const f of fontsByCategory(cat)) loadFontSpecimen(f.family, "The quick brown fox");
    }
  }

  function pickFont(family: string) {
    if (!browsing) return;
    design.fonts[browsing] = family;
    markCustom();
    browsing = null;
  }

  const swatchKeys = [
    ["color-bg", "Background"],
    ["color-surface", "Surface"],
    ["color-surface-raised", "Surface raised"],
    ["color-surface-sunken", "Surface sunken"],
    ["color-border", "Border"],
    ["color-text", "Text"],
    ["color-text-secondary", "Text secondary"],
    ["color-muted", "Muted"],
    ["color-accent", "Primary"],
    ["color-highlight", "Accent"],
    ["color-success", "Success"],
    ["color-warning", "Warning"],
    ["color-error", "Danger"],
  ] as const;

  function ratio(a: string, b: string): string {
    return contrastRatio(a, b).toFixed(1);
  }
</script>

<div class="design-page" data-testid="design-page">
  <aside class="rail" data-testid="design-rail">
    <div class="rail-head">
      <h1 class="rail-title">Design system</h1>
      <p class="rail-sub">{design.name}{design.preset ? "" : " (custom)"}</p>
    </div>

    <section class="rail-section">
      <label class="label" for="design-preset">Preset</label>
      <select
        id="design-preset"
        class="select"
        data-testid="design-rail-select-preset"
        value={design.preset ?? ""}
        onchange={(e) => applyPreset((e.currentTarget as HTMLSelectElement).value)}
      >
        <option value="" disabled>Custom</option>
        {#each DESIGN_PRESETS as p}
          <option value={p.id}>{p.label}</option>
        {/each}
      </select>
      {#if design.preset}
        <p class="help-text">{findPreset(design.preset)?.summary}</p>
      {/if}
    </section>

    <section class="rail-section">
      <h2 class="rail-h">Fonts</h2>
      {#each [["heading", "Heading (primary)"], ["body", "Body (secondary)"], ["mono", "Mono (tertiary)"]] as [slot, lbl]}
        <div class="font-row">
          <div class="form-field">
            <label class="label" for={`design-font-${slot}`}>{lbl}</label>
            <select
              id={`design-font-${slot}`}
              class="select"
              data-testid={`design-rail-select-font-${slot}`}
              bind:value={design.fonts[slot as "heading" | "body" | "mono"]}
              onchange={markCustom}
            >
              {#each (slot === "mono" ? ["mono"] : ["sans", "serif", "display"]) as cat}
                <optgroup label={FONT_CATEGORY_LABELS[cat as FontCategory]}>
                  {#each fontsByCategory(cat as FontCategory) as f}
                    <option value={f.family}>{f.family}</option>
                  {/each}
                </optgroup>
              {/each}
              {#if !findFont(design.fonts[slot as "heading" | "body" | "mono"])}
                <option value={design.fonts[slot as "heading" | "body" | "mono"]}>{design.fonts[slot as "heading" | "body" | "mono"]} (custom)</option>
              {/if}
            </select>
          </div>
          <button
            class="btn btn-secondary btn-sm"
            type="button"
            data-testid={`design-rail-btn-browse-${slot}`}
            onclick={() => openBrowser(slot as "heading" | "body" | "mono")}
          >Browse</button>
        </div>
      {/each}
      <div class="two">
        <div class="form-field">
          <label class="label" for="design-heading-weight">Heading weight</label>
          <select id="design-heading-weight" class="select" data-testid="design-rail-select-heading-weight" bind:value={design.fonts.headingWeight} onchange={markCustom}>
            {#each [400, 500, 600, 700, 800] as w}<option value={w}>{w}</option>{/each}
          </select>
        </div>
        <div class="form-field">
          <label class="label" for="design-body-weight">Body weight</label>
          <select id="design-body-weight" class="select" data-testid="design-rail-select-body-weight" bind:value={design.fonts.bodyWeight} onchange={markCustom}>
            {#each [400, 500] as w}<option value={w}>{w}</option>{/each}
          </select>
        </div>
      </div>
    </section>

    <section class="rail-section">
      <h2 class="rail-h">Colours</h2>
      <p class="help-text">Palette intent. A dark palette renders dark in both themes; a light one still gets the user's dark-mode toggle.</p>
      <div class="mode-row" role="group" aria-label="Mode">
        <button type="button" class="btn btn-sm" class:btn-primary={design.mode === "light"} class:btn-secondary={design.mode !== "light"} data-testid="design-rail-btn-mode-light" onclick={() => setMode("light")}>Light</button>
        <button type="button" class="btn btn-sm" class:btn-primary={design.mode === "dark"} class:btn-secondary={design.mode !== "dark"} data-testid="design-rail-btn-mode-dark" onclick={() => setMode("dark")}>Dark</button>
      </div>
      {#each [["primary", "Primary (actions)"], ["accent", "Accent"], ["background", "Background"], ["surface", "Surface"], ["text", "Text"]] as [key, lbl]}
        <div class="color-row">
          <label class="label" for={`design-color-${key}`}>{lbl}</label>
          <div class="color-inputs">
            <input
              id={`design-color-${key}`}
              type="color"
              class="color-well"
              data-testid={`design-rail-color-${key}`}
              bind:value={design.colors[key as "primary" | "accent" | "background" | "surface" | "text"]}
              oninput={markCustom}
            />
            <input
              type="text"
              class="input input-hex"
              data-testid={`design-rail-input-${key}`}
              bind:value={design.colors[key as "primary" | "accent" | "background" | "surface" | "text"]}
              oninput={markCustom}
              spellcheck="false"
            />
          </div>
        </div>
      {/each}
    </section>

    <section class="rail-section">
      <h2 class="rail-h">Shape</h2>
      <div class="form-field">
        <label class="label" for="design-radius">Corner radius</label>
        <select id="design-radius" class="select" data-testid="design-rail-select-radius" bind:value={design.shape.radius} onchange={markCustom}>
          {#each RADIUS_PRESETS as r}<option value={r}>{r}</option>{/each}
        </select>
      </div>
      <div class="two">
        <div class="form-field">
          <label class="label" for="design-shadow">Shadow</label>
          <select id="design-shadow" class="select" data-testid="design-rail-select-shadow" bind:value={design.shape.shadow} onchange={markCustom}>
            {#each SHADOW_PRESETS as s}<option value={s}>{s}</option>{/each}
          </select>
        </div>
        <div class="form-field">
          <label class="label" for="design-border">Border</label>
          <select id="design-border" class="select" data-testid="design-rail-select-border" bind:value={design.shape.borderWidth} onchange={markCustom}>
            <option value={1}>1px</option>
            <option value={2}>2px</option>
          </select>
        </div>
      </div>
    </section>

    <section class="rail-section">
      <h2 class="rail-h">Type</h2>
      <div class="two">
        <div class="form-field">
          <label class="label" for="design-base-size">Base size</label>
          <select id="design-base-size" class="select" data-testid="design-rail-select-base-size" bind:value={design.type.baseSize} onchange={markCustom}>
            {#each [15, 16, 17, 18] as s}<option value={s}>{s}px</option>{/each}
          </select>
        </div>
        <div class="form-field">
          <label class="label" for="design-scale">Scale</label>
          <select id="design-scale" class="select" data-testid="design-rail-select-scale" bind:value={design.type.scale} onchange={markCustom}>
            {#each TYPE_SCALES as s}<option value={s}>{s}</option>{/each}
          </select>
        </div>
      </div>
      <div class="two">
        <div class="form-field">
          <label class="label" for="design-tracking">Heading tracking</label>
          <select id="design-tracking" class="select" data-testid="design-rail-select-tracking" bind:value={design.type.headingTracking} onchange={markCustom}>
            {#each [-0.03, -0.02, -0.01, 0, 0.02, 0.05] as t}<option value={t}>{t}em</option>{/each}
          </select>
        </div>
        <div class="form-field">
          <label class="label" for="design-case">Heading case</label>
          <select id="design-case" class="select" data-testid="design-rail-select-case" bind:value={design.type.headingCase} onchange={markCustom}>
            {#each HEADING_CASES as c}<option value={c}>{c}</option>{/each}
          </select>
        </div>
      </div>
      <div class="form-field">
        <label class="label" for="design-density">Density</label>
        <select id="design-density" class="select" data-testid="design-rail-select-density" bind:value={design.density} onchange={markCustom}>
          {#each DENSITIES as d}<option value={d}>{d}</option>{/each}
        </select>
      </div>
    </section>

    {#if issues.length}
      <section class="rail-section" data-testid="design-rail-issues">
        <h2 class="rail-h">Checks</h2>
        <ul class="issues">
          {#each issues as issue}
            <li class="issue issue-{issue.level}">{issue.message}</li>
          {/each}
        </ul>
      </section>
    {:else}
      <section class="rail-section">
        <p class="help-text" data-testid="design-rail-issues-none">All contrast checks pass (WCAG AA).</p>
      </section>
    {/if}

    <section class="rail-section rail-actions">
      {#if IS_DEV}
        <button class="btn btn-primary" type="button" data-testid="design-rail-btn-save" disabled={blocked || !dirty || saveState === "saving"} onclick={save}>
          {saveState === "saving" ? "Saving…" : "Save to project"}
        </button>
      {/if}
      <button class="btn btn-secondary" type="button" data-testid="design-rail-btn-copy" onclick={copyJson}>{copied ? "Copied" : "Copy JSON"}</button>
      <button class="btn btn-ghost" type="button" data-testid="design-rail-btn-reset" disabled={!dirty} onclick={reset}>Reset</button>
      {#if saveState === "saved" || saveState === "error"}
        <p class="help-text" class:is-error={saveState === "error"} data-testid="design-rail-save-message">{saveMessage}</p>
      {/if}
    </section>
  </aside>

  <main class="sheet">
    <header class="sheet-head">
      <h1>{design.name}</h1>
      <p class="page-subtitle">Every component this app ships, rendered with the current design. Change anything on the left and watch all of it move.</p>
    </header>

    <!-- Typography -->
    <section class="block" id="typography">
      <h2 class="block-title">Typography</h2>
      <div class="specimens">
        {#each [["heading", "Heading"], ["body", "Body"], ["mono", "Mono"]] as [slot, lbl]}
          {@const fam = design.fonts[slot as "heading" | "body" | "mono"]}
          <div class="card specimen" style:font-family={`"${fam}", ${slot === "mono" ? "monospace" : "sans-serif"}`}>
            <div class="specimen-meta"><span class="badge">{lbl}</span> <span class="text-muted">{fam}</span></div>
            <p class="specimen-big" style:font-weight={slot === "heading" ? design.fonts.headingWeight : design.fonts.bodyWeight}>Aa Bb Gg Qq 0123</p>
            <p class="specimen-line">The quick brown fox jumps over the lazy dog.</p>
            {#if findFont(fam)}<p class="help-text">{findFont(fam)?.note}</p>{/if}
          </div>
        {/each}
      </div>
      <div class="card type-scale">
        <h1>Heading one, the largest voice on the page</h1>
        <h2>Heading two introduces a section</h2>
        <h3>Heading three labels a group</h3>
        <h4>Heading four for cards and rows</h4>
        <p>Body text at the base size. A design system is a set of decisions made once so that every screen after it can be made quickly and still look like it belongs. Links look like <a href="#typography">this</a>, and inline code like <code>enqueueEmail()</code>.</p>
        <p class="text-muted">Muted text for captions and secondary information.</p>
        <pre><code>const next = nextRunAfter("0 9 * * 1", "America/Chicago", now);</code></pre>
        <p>Press <kbd>⌘</kbd> <kbd>K</kbd> to search.</p>
      </div>
    </section>

    <!-- Colour -->
    <section class="block" id="colour">
      <h2 class="block-title">Colour</h2>
      <div class="swatches">
        {#each swatchKeys as [key, lbl]}
          {@const raw = vars[key] ?? ""}
          <div class="swatch">
            <div class="swatch-chip" style:background={`var(--${key})`}></div>
            <div class="swatch-name">{lbl}</div>
            <!-- Tokens app.css derives itself (accent ramp, semantic ramps) are not in `vars`. -->
            <div class="swatch-val">{raw.startsWith("#") ? raw : "derived"}</div>
          </div>
        {/each}
      </div>
      <p class="help-text">Text on background {ratio(design.colors.text, design.colors.background)}:1 · text on surface {ratio(design.colors.text, design.colors.surface)}:1 · label on primary {ratio(bestTextOn(design.colors.primary), design.colors.primary)}:1. WCAG AA asks for 4.5:1.</p>
    </section>

    <!-- Buttons -->
    <section class="block" id="buttons">
      <h2 class="block-title">Buttons</h2>
      <div class="card stack">
        <div class="row">
          <button class="btn btn-primary" data-testid="design-sheet-btn-primary">Primary</button>
          <button class="btn btn-secondary" data-testid="design-sheet-btn-secondary">Secondary</button>
          <button class="btn btn-ghost" data-testid="design-sheet-btn-ghost">Ghost</button>
          <button class="btn btn-danger" data-testid="design-sheet-btn-danger">Danger</button>
          <button class="btn btn-link" data-testid="design-sheet-btn-link">Link button</button>
        </div>
        <div class="row">
          <button class="btn btn-primary btn-sm">Small</button>
          <button class="btn btn-primary">Default</button>
          <button class="btn btn-primary btn-lg">Large</button>
          <button class="btn btn-primary" disabled>Disabled</button>
          <button class="btn btn-secondary" disabled>Disabled</button>
        </div>
      </div>
    </section>

    <!-- Forms -->
    <section class="block" id="forms">
      <h2 class="block-title">Form controls</h2>
      <div class="card form-grid">
        <div class="form-field">
          <label class="label" for="sheet-input">Text input</label>
          <input id="sheet-input" class="input" placeholder="Jane Doe" data-testid="design-sheet-input-text" />
          <p class="help-text">Help text sits under the control.</p>
        </div>
        <div class="form-field">
          <label class="label" for="sheet-input-err">With an error</label>
          <input id="sheet-input-err" class="input is-invalid" value="not-an-email" data-testid="design-sheet-input-invalid" />
          <p class="help-text is-error">Enter a valid email address.</p>
        </div>
        <div class="form-field">
          <label class="label" for="sheet-select">Select</label>
          <select id="sheet-select" class="select" data-testid="design-sheet-select">
            <option>Editor</option><option>Admin</option><option>Viewer</option>
          </select>
        </div>
        <div class="form-field">
          <label class="label" for="sheet-input-disabled">Disabled</label>
          <input id="sheet-input-disabled" class="input" value="Read only" disabled />
        </div>
        <div class="form-field form-span">
          <label class="label" for="sheet-textarea">Textarea</label>
          <textarea id="sheet-textarea" class="textarea" placeholder="Tell us what happened…" data-testid="design-sheet-textarea"></textarea>
        </div>
        <div class="row form-span">
          <label class="checkbox"><input type="checkbox" checked data-testid="design-sheet-checkbox" /> Checkbox</label>
          <label class="radio"><input type="radio" name="sheet-radio" checked data-testid="design-sheet-radio-a" /> Radio A</label>
          <label class="radio"><input type="radio" name="sheet-radio" data-testid="design-sheet-radio-b" /> Radio B</label>
          <label class="switch"><input type="checkbox" bind:checked={switchOn} data-testid="design-sheet-switch" /> Switch {switchOn ? "on" : "off"}</label>
        </div>
      </div>
    </section>

    <!-- Feedback -->
    <section class="block" id="feedback">
      <h2 class="block-title">Badges &amp; alerts</h2>
      <div class="card stack">
        <div class="row">
          <span class="badge">Default</span>
          <span class="badge badge-accent">Primary</span>
          <span class="badge badge-highlight">Accent</span>
          <span class="badge badge-success">Success</span>
          <span class="badge badge-warning">Warning</span>
          <span class="badge badge-danger">Danger</span>
        </div>
        <div class="alert alert-info">Info: your trial ends in 3 days.</div>
        <div class="alert alert-success">Success: invitation sent to jane@example.com.</div>
        <div class="alert alert-warning">Warning: this schedule fires every 5 minutes.</div>
        <div class="alert alert-error">Error: we couldn't reach the payment provider.</div>
      </div>
    </section>

    <!-- Surfaces -->
    <section class="block" id="surfaces">
      <h2 class="block-title">Cards, stats &amp; empty states</h2>
      <div class="stats-grid">
        <div class="card stat-card">
          <div class="stat-label">Monthly revenue</div>
          <div class="stat-value">$24,310</div>
          <div class="stat-hint">+12% vs last month</div>
        </div>
        <div class="card stat-card">
          <div class="stat-label">Active members</div>
          <div class="stat-value">148</div>
          <div class="stat-hint"><a href="#surfaces">Manage team</a></div>
        </div>
        <div class="card stat-card">
          <div class="stat-label">Plan</div>
          <div class="stat-value"><span class="badge badge-accent">PRO</span></div>
          <div class="stat-hint">Renews 14 Oct</div>
        </div>
      </div>
      <div class="two-col">
        <div class="card">
          <h3 class="card-title">Card title</h3>
          <p class="text-muted">Cards hold one thing. This one holds a paragraph and an action.</p>
          <hr class="divider" />
          <button class="btn btn-secondary btn-sm">Action</button>
        </div>
        <div class="card">
          <div class="empty-state">
            <p>No projects yet.</p>
            <button class="btn btn-primary btn-sm">Create your first project</button>
          </div>
        </div>
      </div>
      <div class="card stack">
        <span class="skeleton" style="width: 40%"></span>
        <span class="skeleton" style="width: 90%"></span>
        <span class="skeleton" style="width: 70%"></span>
      </div>
    </section>

    <!-- Navigation -->
    <section class="block" id="navigation">
      <h2 class="block-title">Tabs, lists &amp; tables</h2>
      <div class="card">
        <div class="tabs">
          {#each ["overview", "members", "billing"] as t}
            <button class="tab" class:active={activeTab === t} onclick={() => (activeTab = t)} data-testid={`design-sheet-tab-${t}`}>{t}</button>
          {/each}
        </div>
        <div class="list-rows">
          {#each [["Ada Lovelace", "ada@example.com", "Owner"], ["Grace Hopper", "grace@example.com", "Admin"], ["Linus Torvalds", "linus@example.com", "Editor"]] as [name, email, role]}
            <div class="list-row">
              <div class="list-row-main">
                <span class="avatar">{name.charAt(0)}</span>
                <div>
                  <div class="list-row-title">{name}</div>
                  <div class="list-row-meta">{email}</div>
                </div>
              </div>
              <div class="list-row-actions">
                <span class="badge">{role}</span>
                <button class="btn btn-ghost btn-sm">Remove</button>
              </div>
            </div>
          {/each}
        </div>
      </div>
      <div class="table-wrap">
        <table class="table">
          <thead><tr><th>Invoice</th><th>Status</th><th>Date</th><th class="num">Amount</th></tr></thead>
          <tbody>
            <tr><td>INV-1042</td><td><span class="badge badge-success">Paid</span></td><td>12 Sep 2026</td><td class="num">$1,200.00</td></tr>
            <tr><td>INV-1041</td><td><span class="badge badge-warning">Due</span></td><td>12 Aug 2026</td><td class="num">$1,200.00</td></tr>
            <tr><td>INV-1040</td><td><span class="badge badge-danger">Failed</span></td><td>12 Jul 2026</td><td class="num">$1,200.00</td></tr>
          </tbody>
        </table>
      </div>
    </section>

    <!-- Overlay -->
    <section class="block" id="overlay">
      <h2 class="block-title">Modal</h2>
      <div class="card row">
        <button class="btn btn-primary" onclick={() => (modalOpen = true)} data-testid="design-sheet-btn-open-modal">Open modal</button>
        <span class="text-muted">Portalled, scroll-locked, ESC and backdrop to close.</span>
      </div>
      <Modal open={modalOpen} title="Rename project" onClose={() => (modalOpen = false)} size="sm">
        <div class="form-field">
          <label class="label" for="sheet-modal-input">Project name</label>
          <input id="sheet-modal-input" class="input" value="Acme CRM" />
        </div>
        {#snippet footer()}
          <button class="btn btn-secondary" onclick={() => (modalOpen = false)}>Cancel</button>
          <button class="btn btn-primary" onclick={() => (modalOpen = false)}>Save</button>
        {/snippet}
      </Modal>
    </section>

    <!-- JSON -->
    <section class="block" id="json">
      <h2 class="block-title">design.json</h2>
      <pre data-testid="design-sheet-json"><code>{json}</code></pre>
    </section>
  </main>

  <!-- Font browser -->
  <Modal open={browsing !== null} title={`Choose a ${browsing ?? ""} font`} onClose={() => (browsing = null)} size="lg">
    <div class="font-grid" data-testid="design-font-browser">
      {#each (browsing === "mono" ? ["mono"] : ["sans", "serif", "display"]) as cat}
        <h3 class="font-grid-cat">{FONT_CATEGORY_LABELS[cat as FontCategory]}</h3>
        {#each fontsByCategory(cat as FontCategory) as f}
          <button
            type="button"
            class="font-option"
            class:selected={browsing !== null && design.fonts[browsing] === f.family}
            style:font-family={`"${f.family}", ${cat === "serif" ? "serif" : cat === "mono" ? "monospace" : "sans-serif"}`}
            data-testid={`design-font-option-${f.family.replace(/\s+/g, "-").toLowerCase()}`}
            onclick={() => pickFont(f.family)}
          >
            <span class="font-option-sample">The quick brown fox</span>
            <span class="font-option-name">{f.family}</span>
            <span class="font-option-note">{f.note}</span>
          </button>
        {/each}
      {/each}
    </div>
  </Modal>
</div>

<style>
  .design-page {
    display: grid;
    grid-template-columns: 300px minmax(0, 1fr);
    min-height: 100vh;
    background: var(--color-bg);
  }

  @media (max-width: 900px) {
    .design-page { grid-template-columns: 1fr; }
    .rail { position: static; height: auto; border-right: none; border-bottom: var(--border-width) solid var(--color-border); }
  }

  .rail {
    position: sticky;
    top: 0;
    height: 100vh;
    overflow-y: auto;
    background: var(--color-surface);
    border-right: var(--border-width) solid var(--color-border);
    padding: var(--space-md);
    display: flex;
    flex-direction: column;
    gap: var(--space-lg);
  }

  .rail-title { font-size: var(--text-xl); }
  .rail-sub { font-size: var(--text-sm); color: var(--color-muted); margin-top: 2px; }
  .rail-h {
    font-family: var(--font-sans);
    font-size: var(--text-xs);
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--color-muted);
    margin-bottom: var(--space-sm);
  }
  .rail-section { display: flex; flex-direction: column; gap: var(--space-sm); }
  .rail-actions { gap: var(--space-xs); margin-top: auto; }
  .two { display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-sm); }
  .font-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: var(--space-xs); align-items: end; }
  .mode-row { display: flex; gap: var(--space-xs); }
  .color-row { display: grid; grid-template-columns: 1fr; gap: 2px; }
  .color-inputs { display: grid; grid-template-columns: 40px 1fr; gap: var(--space-xs); }
  .color-well {
    width: 40px;
    height: 34px;
    padding: 0;
    border: var(--border-width) solid var(--color-border);
    border-radius: var(--radius-control);
    background: none;
    cursor: pointer;
  }
  .input-hex { font-family: var(--font-mono); font-size: var(--text-xs); }

  .issues { list-style: none; display: flex; flex-direction: column; gap: var(--space-xs); }
  .issue { font-size: var(--text-xs); padding: var(--space-xs) var(--space-sm); border-radius: var(--radius-sm); }
  .issue-error { background: var(--color-error-bg); color: var(--color-error); }
  .issue-warn { background: var(--color-warning-bg); color: var(--color-warning); }

  .sheet { padding: var(--space-xl); max-width: 1100px; display: flex; flex-direction: column; gap: var(--space-2xl); }
  .sheet-head h1 { margin-bottom: var(--space-xs); }
  .block { display: flex; flex-direction: column; gap: var(--space-md); }
  .block-title { font-size: var(--text-xl); }

  .specimens { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: var(--space-md); }
  .specimen-meta { display: flex; align-items: center; gap: var(--space-sm); margin-bottom: var(--space-sm); }
  .specimen-big { font-size: var(--text-3xl); line-height: 1.1; margin-bottom: var(--space-xs); }
  .specimen-line { font-size: var(--text-base); }
  .type-scale { display: flex; flex-direction: column; gap: var(--space-md); }

  .swatches { display: grid; grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); gap: var(--space-sm); }
  .swatch { display: flex; flex-direction: column; gap: 4px; }
  .swatch-chip { height: 56px; border-radius: var(--radius-md); border: var(--border-width) solid var(--color-border); }
  .swatch-name { font-size: var(--text-xs); font-weight: 500; }
  .swatch-val { font-family: var(--font-mono); font-size: var(--text-xs); color: var(--color-muted); }

  .form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-md); }
  .form-span { grid-column: 1 / -1; }
  @media (max-width: 700px) { .form-grid { grid-template-columns: 1fr; } }

  .stats-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: var(--space-md); }
  .two-col { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: var(--space-md); }

  .font-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: var(--space-sm); }
  .font-grid-cat { grid-column: 1 / -1; font-family: var(--font-sans); font-size: var(--text-xs); text-transform: uppercase; letter-spacing: 0.06em; color: var(--color-muted); margin-top: var(--space-sm); }
  .font-option {
    display: flex;
    flex-direction: column;
    gap: 2px;
    text-align: left;
    padding: var(--space-sm) var(--space-md);
    background: var(--color-surface-raised);
    border: var(--border-width) solid var(--color-border);
    border-radius: var(--radius-md);
    cursor: pointer;
    color: var(--color-text);
  }
  .font-option:hover { border-color: var(--color-accent); }
  .font-option.selected { border-color: var(--color-accent); box-shadow: 0 0 0 3px var(--color-focus-ring); }
  .font-option-sample { font-size: var(--text-lg); line-height: 1.2; }
  .font-option-name { font-family: var(--font-sans); font-size: var(--text-xs); font-weight: 600; }
  .font-option-note { font-family: var(--font-sans); font-size: var(--text-xs); color: var(--color-muted); }
</style>
