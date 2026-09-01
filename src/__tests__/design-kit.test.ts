/**
 * Design-system S1 — component-kit slice.
 *
 * Coverage (source-shape lints, following the culture in devpanel.test.ts /
 * design-tokens.test.ts — this repo has no browser test runner for Svelte,
 * so component-kit correctness is verified by reading the compiled source
 * for the invariants that matter):
 *
 *   - app.css: warning/info semantic ramps exist and are color-mix derived
 *     (no hand-picked hex), the .btn[data-loading] spinner is fully wired
 *     (::after ring + keyframe) and gated behind prefers-reduced-motion,
 *     .alert-warning/.alert-info exist alongside success/error.
 *   - Toast kit: web/src/stores/toast.svelte.ts registers via defineStore,
 *     web/src/components/ToastContainer.svelte is keyboard/a11y-sound
 *     (role="status", aria-live region, a real <button> dismiss control)
 *     and is mounted from App.svelte; main.ts eager-imports the store.
 *   - Regression guards: the screens touched by this slice (Login, Signup,
 *     Docs, InboundEmails, InboundEmailDetail) don't reintroduce a raw hex
 *     color literal in their <style> blocks, and don't reference the
 *     undefined --color-primary custom property.
 *
 * This file intentionally does NOT re-implement the general-purpose
 * "no raw hex anywhere in web/src" guardrail lint — that's a separate S1
 * work item (see design-tokens.test.ts's own scope note) with its own test.
 */

import { assert, assertStringIncludes } from "@std/assert";

function deno(name: string, fn: () => void | Promise<void>) {
  Deno.test({ name, sanitizeResources: false, sanitizeOps: false, fn });
}

async function read(path: string): Promise<string> {
  return await Deno.readTextFile(path);
}

// ── app.css: warning/info tokens + loading spinner ──────────────────────────

deno("app.css: --color-warning-*/--color-info-* ramps are color-mix derived", async () => {
  const css = await read("web/src/app.css");
  for (const base of ["warning", "info"]) {
    assertStringIncludes(css, `--color-${base}:`);
    for (const shade of ["hover", "bg", "border", "contrast"]) {
      const varName = `--color-${base}-${shade}`;
      assert(css.includes(varName), `app.css should define ${varName}`);
    }
  }
  // Every ramp shade off warning/info must be color-mix(), not a literal.
  const warningBgLine = css.split("\n").find((l) => l.trim().startsWith("--color-warning-bg:"));
  const infoBgLine = css.split("\n").find((l) => l.trim().startsWith("--color-info-bg:"));
  assert(warningBgLine?.includes("color-mix("), "--color-warning-bg must be color-mix derived");
  assert(infoBgLine?.includes("color-mix("), "--color-info-bg must be color-mix derived");
});

deno("app.css: .alert-warning and .alert-info exist alongside success/error", async () => {
  const css = await read("web/src/app.css");
  assertStringIncludes(css, ".alert-warning {");
  assertStringIncludes(css, ".alert-info {");
});

deno("app.css: .btn[data-loading] renders a real spinner gated on reduced-motion", async () => {
  const css = await read("web/src/app.css");
  assertStringIncludes(css, ".btn[data-loading]::after");
  assertStringIncludes(css, "@keyframes btn-spin");
  assertStringIncludes(css, "animation: btn-spin");
  // The reduced-motion guard must appear AFTER the animation is declared,
  // and must disable it rather than removing the visual affordance.
  const reducedIdx = css.indexOf("@media (prefers-reduced-motion: reduce)");
  const spinIdx = css.indexOf("@keyframes btn-spin");
  assert(
    reducedIdx > -1 && reducedIdx > spinIdx,
    "reduced-motion guard must follow the spin keyframe",
  );
  assertStringIncludes(css, "animation: none;");
});

deno(
  "app.css: every .btn-* variant sets --btn-loading-fg (spinner color, not currentColor)",
  async () => {
    const css = await read("web/src/app.css");
    for (const variant of ["btn-primary", "btn-secondary", "btn-ghost", "btn-danger"]) {
      const block = css.split(`.${variant} {`)[1]?.split("}")[0] ?? "";
      assert(
        block.includes("--btn-loading-fg:"),
        `.${variant} must set --btn-loading-fg so its loading spinner is visible`,
      );
    }
  },
);

// ── Toast kit ────────────────────────────────────────────────────────────────

deno("toast store: registers via defineStore (DevPanel-visible)", async () => {
  const src = await read("web/src/stores/toast.svelte.ts");
  assertStringIncludes(src, 'defineStore<ToastState>("toast"');
  // Array replacement, not push() — see CLAUDE.md "Stores and the DevPanel".
  assert(
    !/state\.toasts\.push\(/.test(src),
    "toast store must replace the array, never push() in place",
  );
});

deno("ToastContainer: keyboard + screen-reader accessible", async () => {
  const src = await read("web/src/components/ToastContainer.svelte");
  assertStringIncludes(src, 'aria-live="polite"');
  assertStringIncludes(src, 'role="status"');
  assertStringIncludes(src, "<button");
  assertStringIncludes(src, 'aria-label="Dismiss notification"');
  // Portalled like <Modal>, not hand-rolled fixed positioning inside a route.
  assertStringIncludes(src, "use:portal");
});

deno("ToastContainer: respects prefers-reduced-motion for enter/exit", async () => {
  const src = await read("web/src/components/ToastContainer.svelte");
  assertStringIncludes(src, "prefers-reduced-motion: reduce");
  assertStringIncludes(src, "duration: 0");
});

deno("App.svelte mounts <ToastContainer />", async () => {
  const src = await read("web/src/App.svelte");
  assertStringIncludes(src, "<ToastContainer />");
  assertStringIncludes(src, 'from "./components/ToastContainer.svelte"');
});

deno("main.ts eager-imports the toast store", async () => {
  const src = await read("web/src/main.ts");
  assertStringIncludes(src, './stores/toast.svelte"');
});

// ── Regression guards on the screens this slice touched ─────────────────────

// No /g flag: this is only ever used with .test() for a boolean check, and a
// global-flagged RegExp carries `lastIndex` state across repeated .test()
// calls, silently producing false negatives/positives on subsequent files.
const HEX_LITERAL = /#[0-9a-fA-F]{3,8}\b/;

/**
 * Extract just the <style> block contents (hex literals inside inline SVG
 * `fill="#..."` markup — e.g. the sanctioned Google "G" logo colors in
 * Signup.svelte — are brand marks, not themable UI, and live outside
 * <style> entirely, so they're excluded by construction here.)
 */
function styleBlocks(svelteSrc: string): string {
  const matches = [...svelteSrc.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)];
  return matches.map((m) => m[1]).join("\n");
}

deno(
  "Login/Signup: no raw hex left in <style>, and no reference to the undefined --color-primary var",
  async () => {
    for (const file of ["web/src/routes/Login.svelte", "web/src/routes/Signup.svelte"]) {
      const src = await read(file);
      const style = styleBlocks(src);
      assert(
        !HEX_LITERAL.test(style),
        `${file}: <style> block should not contain a raw hex literal`,
      );
      assert(
        !style.includes("--color-primary"),
        `${file}: --color-primary is not a defined token (use --color-accent)`,
      );
    }
  },
);

deno(
  "Docs.svelte: uses real design tokens, not the orphaned --border/--muted/--accent namespace",
  async () => {
    const src = await read("web/src/routes/Docs.svelte");
    const style = styleBlocks(src);
    assert(
      !HEX_LITERAL.test(style),
      "Docs.svelte: <style> block should not contain a raw hex literal",
    );
    for (
      const orphan of [
        "var(--border",
        "var(--muted",
        "var(--accent",
        "var(--text,",
        "var(--hover",
        "var(--code-bg",
        "var(--code-fg",
      ]
    ) {
      assert(
        !style.includes(orphan),
        `Docs.svelte should not reference the orphaned ${orphan} var`,
      );
    }
  },
);

deno(
  "InboundEmails/InboundEmailDetail: status badges derive from --color-warning-*/--color-info-* tokens",
  async () => {
    for (
      const file of [
        "web/src/routes/InboundEmails.svelte",
        "web/src/routes/InboundEmailDetail.svelte",
      ]
    ) {
      const src = await read(file);
      const style = styleBlocks(src);
      assert(
        !HEX_LITERAL.test(style),
        `${file}: <style> block should not contain a raw hex literal`,
      );
      assertStringIncludes(style, "var(--color-warning-bg)");
      assertStringIncludes(style, "var(--color-info-bg)");
    }
  },
);
