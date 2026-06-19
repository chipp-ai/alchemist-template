/**
 * Svelte `modalBehavior` action — wires scroll-lock, ESC-to-close, and
 * focus management for a modal/dialog root node. Pair it with `portal`
 * (see ./portal.ts); the <Modal> component composes both for you.
 *
 * Scroll-lock target:
 *   The shell's real scroll container is `.app-main`
 *   (`overflow-y: auto` inside `.app-layout { height: 100vh }` per
 *   App.svelte). `<body>` does NOT scroll on the shell layout. So the lock
 *   targets `.app-main` (primary) AND `<body>` (fallback for any route that
 *   does not use the shell, e.g. the un-authed Router branch). A ref-count
 *   keeps the lock correct when two overlays stack: the second open
 *   increments, the first close does not release until all are closed.
 *
 * ESC to close:
 *   A `keydown` listener on `window` fires `onClose()` on `Escape`. It is
 *   registered on invoke and torn down on destroy, so it never leaks across
 *   navigations.
 *
 * Focus management:
 *   On mount: capture `document.activeElement`, then move focus to the first
 *   focusable descendant. On destroy: restore focus to the previously
 *   focused element.
 *
 * Usage (prefer the <Modal> component over wiring this by hand):
 *   import { modalBehavior } from "../lib/modal";
 *   <div use:modalBehavior={{ onClose }}>...</div>
 */

interface ModalBehaviorParams {
  onClose: () => void;
}

// ── Ref-counted scroll lock ────────────────────────────────────────────────────

let lockCount = 0;
let savedAppMainOverflow = "";
let savedBodyOverflow = "";
let savedBodyPaddingRight = "";

function lockScroll() {
  if (lockCount === 0) {
    const appMain = document.querySelector<HTMLElement>(".app-main");
    if (appMain) {
      savedAppMainOverflow = appMain.style.overflow;
      appMain.style.overflow = "hidden";
    }

    // Body fallback + scrollbar-width compensation (prevents layout shift
    // when the scrollbar disappears under the lock).
    const scrollbarWidth = window.innerWidth - document.documentElement.clientWidth;
    savedBodyOverflow = document.body.style.overflow;
    savedBodyPaddingRight = document.body.style.paddingRight;
    document.body.style.overflow = "hidden";
    if (scrollbarWidth > 0) {
      document.body.style.paddingRight = `${scrollbarWidth}px`;
    }
  }
  lockCount++;
}

function unlockScroll() {
  lockCount = Math.max(0, lockCount - 1);
  if (lockCount === 0) {
    const appMain = document.querySelector<HTMLElement>(".app-main");
    if (appMain) {
      appMain.style.overflow = savedAppMainOverflow;
    }
    document.body.style.overflow = savedBodyOverflow;
    document.body.style.paddingRight = savedBodyPaddingRight;
  }
}

// ── Focus helpers ─────────────────────────────────────────────────────────────

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),' +
  'textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

function moveFocusInto(node: Element): Element | null {
  const first = node.querySelector<HTMLElement>(FOCUSABLE);
  if (first) {
    first.focus();
    return first;
  }
  return null;
}

// ── Action ────────────────────────────────────────────────────────────────────

export function modalBehavior(node: Element, params: ModalBehaviorParams) {
  let { onClose } = params;
  const previousFocus = document.activeElement as HTMLElement | null;

  lockScroll();

  // Move focus into the modal after the frame so the DOM (post-portal) settles.
  requestAnimationFrame(() => moveFocusInto(node));

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  }

  window.addEventListener("keydown", onKeyDown);

  return {
    update(p: ModalBehaviorParams) {
      onClose = p.onClose;
    },
    destroy() {
      window.removeEventListener("keydown", onKeyDown);
      unlockScroll();
      if (previousFocus && typeof previousFocus.focus === "function") {
        previousFocus.focus();
      }
    },
  };
}
