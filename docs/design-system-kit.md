# Design-system S1 — component kit refresh (this slice)

**Status:** implemented — this is the component-kit slice of ALCHEM7-3 (S1):
completing `.btn`'s loading state, adding a Toast primitive (previously
missing entirely), and clearing raw-hex / broken-token regressions out of
the existing screens (Login, Signup, Docs, Inbound Email). Motion.css,
dark-mode theming, and the S5 guardrail lints + `web/DESIGN.md` are separate
slices of the same ticket. See `docs/design-system-program.md` for the full
S-series plan and `docs/design-system-tokens.md` for the tokens/typography/
brand-loader slice this one builds on.

## Problem

Three concrete gaps found while refreshing the component kit:

1. `.btn[data-loading]` hid the button label but never actually rendered a
   spinner — the comment pointed at a `motion.css` keyframe that didn't
   exist yet, so the loading state was visually silent (a disabled-looking
   button with no affordance).
2. There was no toast/notification primitive at all. Nothing in
   `web/src/components/` or `web/src/stores/` covered transient
   notifications, despite `.alert` covering only inline/persistent messages.
3. Several existing screens had drifted from the token system: duplicate
   `.alert-success` overrides with hand-picked fallback hexes (Login,
   Signup), a reference to an undefined `--color-primary` var, an entire
   orphaned `--border`/`--muted`/`--accent`/`--text`/`--hover`/`--code-bg`/
   `--code-fg` namespace in `Docs.svelte` that never matched any real token
   (so it always rendered its literal hex fallbacks), and hand-picked amber/
   blue hex for `.badge-warn`/`.badge-info` on the Inbound Email screens
   with no brand connection at all.

## Decision

**Extend the token system rather than patch each screen locally.** The
badge warn/info colors needed a real home: added `--color-warning-*` /
`--color-info-*` to `web/src/app.css`, derived via `color-mix()` off a
single hand-picked base hue each — the same discipline already used for
`--color-error`/`--color-success` (see `docs/design-system-tokens.md`).
`.alert-warning`/`.alert-info` were added alongside `.alert-error`/
`.alert-success` for parity even though no screen consumes them yet, so the
next feature that needs a warning banner doesn't reinvent this.

**The loading spinner's color needed a per-variant custom property.**
`.btn[data-loading]` forces `color: transparent` to hide the label, so the
spinner's `::after` pseudo-element can't lean on `currentColor` — it would
resolve to transparent too. Introduced `--btn-loading-fg`, set by each
`.btn-*` variant to the color it would have used for its text, and the
spinner ring reads that. Centering uses `top/left: 50%` + a negative
`margin` (not `transform: translate(-50%, -50%)`), because `transform` is
also what the spin keyframe animates — stacking two transforms on the same
declaration would require `transform` composition math instead of the
simpler margin offset.

- **Rejected: waiting for `motion.css` to land the keyframe.** The
  `.btn[data-loading]` selector and comment already existed pointing at a
  file that doesn't exist in this repo yet (a sibling ticket's scope). A
  button's own loading spinner is squarely "component kit," not a page-level
  motion effect, so it's implemented directly in `app.css` and gated behind
  `prefers-reduced-motion` itself rather than being blocked on another
  slice.
- **Rejected: reduced-motion hides the spinner entirely.** Dropping the
  `animation` still leaves a static ring — the user gets a "this is busy"
  affordance either way, they just don't see it spin. Removing the ring
  entirely would silently regress the loading indicator for users with
  the OS setting on.

**Toasts follow the same primitives as `<Modal>`.** `ToastContainer.svelte`
uses the same `portal` action (renders to `#overlay-root`, immune to the
containing-block trap documented in `web/src/lib/portal.ts`) and mounts
once in `App.svelte`, same as `<DevPanel>`/`<SessionTimeoutWarning>`. State
lives in `web/src/stores/toast.svelte.ts` via `defineStore` (DevPanel/
`/api/dev/app-state` introspectable, per CLAUDE.md's store convention) —
callers never touch the DOM, they call `toastStore.show(...)` /
`.success()` / `.error()` / `.warning()` / `.info()` from anywhere.

- **Rejected: a bare `alert()`-replacement with no store.** Multiple
  in-flight async operations (e.g. batch actions) need to stack more than
  one toast and dismiss them independently; a singleton "current toast"
  slot can't represent that.
- **Rejected: CSS-only enter/exit (no JS).** Svelte's `in:fly`/`out:fly`
  transition directives already collapse to `duration: 0` under
  `prefers-reduced-motion` with one guard at the top of the component
  (checked once via `matchMedia`), which is simpler than authoring parallel
  CSS animation classes.

**Screen fixes were tokenization, not redesign.** Every hex/broken-var fix
in Login, Signup, Docs, InboundEmails, and InboundEmailDetail replaces a
literal or dead variable with an existing (or newly added) token — no
layout or copy changes.

## Public contract

### New files

- `web/src/stores/toast.svelte.ts` — `toastStore.show(message, variant?,
  { durationMs? })` / `.info()` / `.success()` / `.warning()` / `.error()`
  / `.dismiss(id)` / `.clear()`. `variant` is `"info" | "success" |
  "warning" | "error"`. `durationMs` defaults to 5000; `0` means "stays
  until dismissed."
- `web/src/components/ToastContainer.svelte` — mount once (already wired
  into `App.svelte`). Renders the live queue; no props.

### `web/src/app.css` additions

| Token | Notes |
|---|---|
| `--color-warning`, `--color-warning-hover/-bg/-border/-contrast` | color-mix ramp off one hand-picked amber base, same pattern as error/success |
| `--color-info`, `--color-info-hover/-bg/-border/-contrast` | color-mix ramp off one hand-picked blue base |
| `.alert-warning`, `.alert-info` | new alert tones alongside existing `.alert-error`/`.alert-success` |
| `--btn-loading-fg` | set per `.btn-*` variant; the loading spinner's ring color |
| `.btn[data-loading]::after` + `@keyframes btn-spin` | the actual spinner (previously undefined); disabled under `prefers-reduced-motion` but stays visible as a static ring |

### Screens touched (no class/behavior changes, token/var fixes only)

- `Login.svelte` / `Signup.svelte`: removed a duplicate local
  `.alert-success` override (the global one in `app.css` already covers
  it) and fixed `.link-btn`'s `color: var(--color-primary)` (undefined) →
  `var(--color-accent)`.
- `Docs.svelte`: every `var(--border|--muted|--accent|--text|--hover|
  --accent-soft|--code-bg|--code-fg, <hex fallback>)` reference replaced
  with the real `--color-*`/`--radius-*` tokens. Code blocks now render
  `background: var(--color-text)` / `color: var(--color-bg)` (an inverted
  ink/paper pair, still fully token-derived).
- `InboundEmails.svelte` / `InboundEmailDetail.svelte`: `.badge-warn`/
  `.badge-info` and the `rgba(...)` border colors on `.badge-good`/
  `.badge-bad` now reference the new warning/info tokens and the existing
  `--color-success-border`/`--color-error-border` instead of restating the
  same math as a literal. `.body-html`'s hardcoded `background: #ffffff`
  → `var(--color-surface-raised)`.

## Gotchas

- **`*/` inside a CSS comment closes the comment early.** Writing
  `--color-warning-*/--color-info-*` in a `/* ... */` block breaks the
  Svelte/PostCSS parser (`Expected a valid CSS identifier`) because `-*/`
  reads as the comment terminator. Any doc comment mentioning two
  wildcard-suffixed token names side by side needs a space around the
  slash: `--color-warning-* / --color-info-*`.
- **A global-flag `RegExp` used only with `.test()` in a loop is a footgun.**
  `/pattern/g.test()` carries `lastIndex` across calls, so reusing one
  `RegExp` instance across multiple file checks in a test silently skips
  matches on the second-and-later calls. The lint helper in
  `src/__tests__/design-kit.test.ts` deliberately drops the `g` flag.
- `--btn-loading-fg` has no effect unless the variant sets it; a future
  `.btn-*` variant that forgets it falls back to `currentColor`, which
  resolves to the forced `transparent` on `.btn[data-loading]` — the
  spinner would render invisible. Any new variant must set
  `--btn-loading-fg` alongside its `color`.
