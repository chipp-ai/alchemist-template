/**
 * Design-system S1 tests — token/derivation math + source-shape lints.
 *
 * Coverage:
 *   - web/src/lib/color-math.ts: WCAG relative luminance, contrast ratio,
 *     and AA-safe contrast-text derivation (the pure math that backs
 *     --brand-primary-contrast, computed at runtime by brand-loader.js).
 *   - Source-shape lints:
 *     - web/src/app.css preserves every pre-existing component class name
 *       (buttons, input, card, badge, alert, empty-state, page-header —
 *       the "keep existing class NAMES so current template code upgrades
 *       in place" contract).
 *     - web/src/app.css defines the full token surface: a >=7-step
 *       modular type scale, a radius scale keyed off [data-radius-scale],
 *       exactly 3 elevation levels, and no hand-picked hex for the
 *       accent/error/success ramps outside the :root token block.
 *     - web/public/brand-loader.js sets the v3 CSS vars (font/radius/
 *       gradient) and keeps the isLightSurface neutral guard intact.
 *
 * This file intentionally does NOT cover motion.css, dark-mode theming,
 * or the guardrail lints for arbitrary component/page styles — those are
 * separate S1 work items with their own tests.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  AA_NORMAL_TEXT_RATIO,
  contrastRatio,
  isLightSurface,
  isValidHex,
  normalizeHex,
  pickContrastText,
  relativeLuminance,
} from "../../web/src/lib/color-math.ts";

function deno(name: string, fn: () => void | Promise<void>) {
  Deno.test({ name, sanitizeResources: false, sanitizeOps: false, fn });
}

// ── color-math.ts: relative luminance + contrast ratio ─────────────────────

deno("color-math: normalizeHex expands shorthand + lowercases", () => {
  assertEquals(normalizeHex("#ABC"), "#aabbcc");
  assertEquals(normalizeHex("#5E6AD2"), "#5e6ad2");
  assertEquals(normalizeHex(" #fff "), "#ffffff");
});

deno("color-math: isValidHex rejects malformed input", () => {
  assertEquals(isValidHex("#5e6ad2"), true);
  assertEquals(isValidHex("#abc"), true);
  assertEquals(isValidHex("not-a-color"), false);
  assertEquals(isValidHex("5e6ad2"), false);
  assertEquals(isValidHex("#12345"), false);
});

deno("color-math: relativeLuminance — black is 0, white is 1", () => {
  assertEquals(relativeLuminance("#000000"), 0);
  assertEquals(relativeLuminance("#ffffff"), 1);
});

deno("color-math: contrastRatio — black/white is the WCAG max (21:1)", () => {
  const ratio = contrastRatio("#000000", "#ffffff");
  assert(Math.abs(ratio - 21) < 0.001, `expected ~21, got ${ratio}`);
});

deno("color-math: contrastRatio is symmetric and self-ratio is 1", () => {
  assertEquals(contrastRatio("#5e6ad2", "#5e6ad2"), 1);
  assertEquals(
    contrastRatio("#5e6ad2", "#ffffff"),
    contrastRatio("#ffffff", "#5e6ad2"),
  );
});

deno("color-math: isLightSurface matches the brand-neutral guard threshold", () => {
  assertEquals(isLightSurface("#ffffff"), true);
  assertEquals(isLightSurface("#fafafa"), true);
  assertEquals(isLightSurface("#111827"), false);
  assertEquals(isLightSurface("#000000"), false);
});

// ── color-math.ts: AA contrast-text derivation ──────────────────────────────

deno("pickContrastText: template default primary (#5e6ad2) picks white, AA-safe", () => {
  const result = pickContrastText("#5e6ad2");
  assertEquals(result.color, "#ffffff");
  assert(result.passesAA, `expected AA pass, ratio was ${result.ratio}`);
  assert(result.ratio >= AA_NORMAL_TEXT_RATIO);
});

deno("pickContrastText: a light brand color picks ink, AA-safe", () => {
  const result = pickContrastText("#f5f5f5");
  assertEquals(result.color, "#111827");
  assert(result.passesAA, `expected AA pass, ratio was ${result.ratio}`);
});

deno("pickContrastText: a saturated dark brand color picks white, AA-safe", () => {
  const result = pickContrastText("#111827");
  assertEquals(result.color, "#ffffff");
  assert(result.passesAA);
});

deno("pickContrastText: always returns the higher-contrast option, even mid-tones", () => {
  // Sweep a range of hues/lightness — whichever of white/ink wins must
  // have the higher (or equal) ratio of the two by construction.
  const samples = [
    "#5e6ad2",
    "#f59e0b",
    "#16a34a",
    "#dc2626",
    "#9333ea",
    "#0891b2",
    "#84cc16",
    "#e11d48",
    "#78716c",
    "#eab308",
  ];
  for (const hex of samples) {
    const result = pickContrastText(hex);
    const whiteRatio = contrastRatio(hex, "#ffffff");
    const inkRatio = contrastRatio(hex, "#111827");
    const bestPossible = Math.max(whiteRatio, inkRatio);
    assert(
      Math.abs(result.ratio - bestPossible) < 1e-9,
      `${hex}: pickContrastText picked ratio ${result.ratio}, best possible was ${bestPossible}`,
    );
  }
});

// ── Source-shape lints: web/src/app.css ─────────────────────────────────────

deno("app.css: preserves every existing component class name", async () => {
  const src = await Deno.readTextFile(
    new URL("../../web/src/app.css", import.meta.url),
  );
  const requiredClasses = [
    ".btn",
    ".btn-primary",
    ".btn-secondary",
    ".btn-ghost",
    ".btn-danger",
    ".input",
    ".label",
    ".card",
    ".badge",
    ".page-header",
    ".page-title",
    ".page-subtitle",
    ".empty-state",
    ".alert",
    ".alert-error",
    ".alert-success",
  ];
  for (const cls of requiredClasses) {
    assertStringIncludes(
      src,
      cls,
      `web/src/app.css must keep the ${cls} class so existing template ` +
        `code upgrades in place instead of breaking on rename.`,
    );
  }
});

deno("app.css: btn carries a data-loading state selector", () => {
  return Deno.readTextFile(new URL("../../web/src/app.css", import.meta.url)).then(
    (src) => {
      assertStringIncludes(
        src,
        `.btn[data-loading]`,
        "app.css must define a loading-state selector for .btn",
      );
    },
  );
});

deno("app.css: type scale has at least 7 modular steps", async () => {
  const src = await Deno.readTextFile(
    new URL("../../web/src/app.css", import.meta.url),
  );
  const steps = ["--text-xs", "--text-sm", "--text-base", "--text-lg", "--text-xl", "--text-2xl", "--text-3xl"];
  for (const step of steps) {
    assertStringIncludes(src, `${step}:`, `app.css must define ${step}`);
  }
});

deno("app.css: radius is keyed off [data-radius-scale] with sharp/soft/round", async () => {
  const src = await Deno.readTextFile(
    new URL("../../web/src/app.css", import.meta.url),
  );
  assertStringIncludes(src, `[data-radius-scale="sharp"]`);
  assertStringIncludes(src, `[data-radius-scale="round"]`);
  assertStringIncludes(src, "--radius-sm");
  assertStringIncludes(src, "--radius-md");
  assertStringIncludes(src, "--radius-lg");
});

deno("app.css: exactly 3 elevation levels (--shadow-sm/-md/-lg)", async () => {
  const src = await Deno.readTextFile(
    new URL("../../web/src/app.css", import.meta.url),
  );
  const shadowTokenNames = new Set(
    [...src.matchAll(/--shadow-([a-z]+):/g)].map((m) => m[1]),
  );
  assertEquals(
    shadowTokenNames,
    new Set(["sm", "md", "lg"]),
    `expected exactly the 3 elevation levels sm/md/lg, found: ${[...shadowTokenNames]}`,
  );
});

deno("app.css: accent/error/success ramps are color-mix derived, not hand-picked", async () => {
  const src = await Deno.readTextFile(
    new URL("../../web/src/app.css", import.meta.url),
  );
  for (
    const token of [
      "--color-accent-hover",
      "--color-accent-active",
      "--color-accent-subtle",
      "--color-error-hover",
      "--color-error-bg",
      "--color-success-hover",
      "--color-success-bg",
    ]
  ) {
    const re = new RegExp(`${token}:\\s*color-mix\\(`);
    assert(
      re.test(src),
      `${token} must be derived via color-mix(), not a hand-picked hex`,
    );
  }
});

deno("app.css: focus-visible ring is defined for interactive elements", async () => {
  const src = await Deno.readTextFile(
    new URL("../../web/src/app.css", import.meta.url),
  );
  assertStringIncludes(src, ":focus-visible");
  assertStringIncludes(src, "--color-focus-ring");
});

// ── Source-shape lints: web/public/brand-loader.js ──────────────────────────

deno("brand-loader.js: sets the v3 font/radius/gradient CSS vars", async () => {
  const src = await Deno.readTextFile(
    new URL("../../web/public/brand-loader.js", import.meta.url),
  );
  for (
    const setVar of [
      `"--brand-font-heading"`,
      `"--brand-font-body"`,
      `"--brand-radius-scale"`,
      `"--brand-gradient-from"`,
      `"--brand-gradient-to"`,
      `"--brand-primary-contrast"`,
    ]
  ) {
    assertStringIncludes(
      src,
      setVar,
      `brand-loader.js must set ${setVar} from brand.json's v3 fields when present`,
    );
  }
  assertStringIncludes(src, "data-radius-scale");
});

deno("brand-loader.js: keeps the isLightSurface neutral guard intact", async () => {
  const src = await Deno.readTextFile(
    new URL("../../web/public/brand-loader.js", import.meta.url),
  );
  assertStringIncludes(
    src,
    `typeof brand.neutralColor === "string" && isLightSurface(brand.neutralColor)`,
    "brand-loader.js must keep clamping --brand-neutral to light-surface values only",
  );
});

deno("brand-loader.js: builds the Google Fonts request with display=swap", async () => {
  const src = await Deno.readTextFile(
    new URL("../../web/public/brand-loader.js", import.meta.url),
  );
  assertStringIncludes(src, "fonts.googleapis.com/css2");
  assertStringIncludes(src, "display=swap");
});
