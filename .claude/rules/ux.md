---
name: ux
description: The consumer UX bar for every screen in the app and the landing site - one state one message, every state designed, plain words with no system names or time promises, toasts for outcomes, one primary action, one left edge, phone and dark mode, and done means seen rendered. Load when building or changing any page, component or user-facing copy.
paths:
  - "web/src/**/*.svelte"
  - "landing/src/**/*.astro"
  - "landing/src/**/*.svelte"
---

# Consumer UX: the bar for every screen

The bar is top-tier consumer software, not "it works". `design.md` and
`web/DESIGN.md` decide how the app LOOKS (design.json, tokens, motion,
mobile). This file decides how it BEHAVES and READS. Both apply.

## States

- **One state, one message.** Everything that echoes a state agrees: the
  badge, the icon, the heading and the button. A "Paid" badge above an
  "Awaiting payment" banner is a bug.
- **Design every state, not the happy path:** loading (`.skeleton` shaped
  like the content, never a blank page), empty (`.empty-state`: what goes
  here and the one action that fills it), error (what happened plus Retry or
  another way out), long text (wraps, or truncates with a `title`), many
  items, and a phone.
- **Lead with what the person came for.** Put the current status or the
  main content first, history and details after.
- **Never show system names or raw machine text**: enum values
  (`pending_review`), table or field names, ids, stack traces, HTTP codes.
  Map them to plain words in one helper and test it. Ids that people need
  (an order number) are fine, styled quietly.

## Feedback

- **Outcomes are toasts** (`toastStore.show(message, "success" | "error")`
  from `web/src/stores/toast.svelte.ts`), not inline success or error
  sentences. Field validation stays inline, under the field.
- **No click is a silent no-op.** A disabled control says why (tooltip or
  help text). A button shows `data-loading` while its request runs and
  cannot be double-submitted.
- Destructive actions confirm through `<Modal>` and name what will be lost.
- Optimistic updates roll back with an error toast if the request fails.

## Words

- Plain, short, specific: what happened, and what to do next. Second person,
  sentence case, the customer's own vocabulary (from the brief or the old
  site), never the developer's.
- **No time promises** ("usually takes a few minutes", "almost done") unless
  the product actually guarantees it. Say what is happening and what stays
  true meanwhile.
- Buttons are verbs that say the outcome ("Send invite", "Save changes"),
  not "Submit" or "OK".
- No placeholder text ships (`landing.md` has the factory copy rules).

## Actions and chrome

- **One primary action per view** (`.btn-primary`). Everything else is
  `.btn-secondary`, `.btn-ghost` or a link. Two primaries means neither is.
- Show as few elements as possible. Rare actions go in an overflow menu.
- No decorative icons: no icon tile beside every heading or row, no generic
  sparkle or robot standing in for content. Keep icons that do a job
  (icon-only buttons with `aria-label`, status, file types, real logos).

## Layout

- **One left edge.** Headings, step indicators, lists and the text under
  them align. No centered column above left-aligned copy.
- Phone first: nothing scrolls sideways, rows stack, tap targets are big
  enough (`web/DESIGN.md` "Mobile and touch").
- Light and dark both look intentional (the user toggles dark mode).
- Motion only where it means something, compositor properties only, off
  under `prefers-reduced-motion` (`web/DESIGN.md` "Motion").

## Done means seen

A UI change is done only after you have looked at it rendered: each state
above, light and dark, desktop and phone width, judged against this file.
Use the browser tools in `docs/conventions/email.md` "Verifying (agent recipe)" (cheapest
first; screenshot when the question is visual). For the landing site,
screenshot the production build of `/` (`landing.md`). After fixing one
problem, check the rest of the screen for the same kind of problem.
