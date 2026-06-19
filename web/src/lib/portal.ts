/**
 * Svelte `portal` action — teleports a DOM node out of its current parent
 * into the shared overlay root (`#overlay-root`, a direct child of `<body>`
 * and sibling of `#app`), escaping any ancestor `transform`, `overflow`, or
 * stacking context that would otherwise clip or misplace a `position: fixed`
 * backdrop/dialog.
 *
 * WHY THIS EXISTS (read before building any overlay):
 * - The shell layout (`App.svelte`) renders every route inside
 *   `.app-main { overflow-y: auto }`. An overflow container can clip a
 *   `position: fixed` descendant in some browsers.
 * - The moment any app adds a route-entry transition (e.g. a `translateY`
 *   keyframe on the route wrapper) or any `transform`/`filter`/`will-change`
 *   on an ancestor, that ancestor becomes the CONTAINING BLOCK for
 *   `position: fixed` children. A `fixed; inset: 0` backdrop then resolves
 *   against that ancestor instead of the viewport, so the modal renders
 *   clipped into the content column rather than centered over the page.
 *   This is a silent trap: the CSS looks correct, the bug only appears once
 *   rendered. It is exactly the failure the `<Modal>` component avoids by
 *   portalling out.
 *
 * Mounting through `#overlay-root` resolves both traps: the overlay resolves
 * against the viewport, unaffected by any inner transform or overflow.
 *
 * Usage in a Svelte component (you usually want <Modal>, not this directly):
 *   import { portal } from "../lib/portal";
 *   <div use:portal class="modal-backdrop">...</div>
 *
 * Svelte teardown still works: when the `{#if}` flips false, Svelte removes
 * the node by reference regardless of where it now lives in the DOM. The
 * `destroy()` callback is defensive (parentNode check) so it is idempotent.
 */
export function portal(node: Element, target: string = "#overlay-root") {
  const dest = document.querySelector(target) ?? document.body;
  dest.appendChild(node);

  return {
    destroy() {
      if (node.parentNode) {
        node.parentNode.removeChild(node);
      }
    },
  };
}
