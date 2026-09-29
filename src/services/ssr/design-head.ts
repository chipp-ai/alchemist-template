/**
 * The project's design on server-rendered pages. Part of the SSR kernel
 * (`.claude/rules/ssr.md`).
 *
 * SSR pages do not load the SPA's app.css. `designHead()` gives them the
 * same tokens the SPA gets from `web/src/design/design.json`: one Google
 * Fonts link and one `<style id="design-tokens">` with the `:root` token
 * rule (`--color-*`, `--space-*`, `--text-*`, `--radius-*`, `--font-*`,
 * `--brand-*`). Page CSS uses those tokens only, never raw colours or
 * sizes, so a design change restyles the public pages too.
 *
 * `designHtmlAttributes()` returns the matching `<html>` attributes with a
 * leading space: `<html lang="en"${designHtmlAttributes()}>`.
 *
 * design.json is read once per process. A missing or invalid file logs an
 * error and falls back to the "clean" preset, so a page never fails to
 * render over its styling.
 */

import { log } from "@/lib/logger.ts";
import { escapeHtml } from "./render-html.ts";
import { checkDesign, DESIGN_FILE_PATH, findPreset } from "@/services/design.service.ts";
import type { DesignConfig } from "../../../web/src/design/types.ts";
import { designStylesheet, RADIUS_SCALE_LABEL } from "../../../web/src/design/tokens.ts";
import { fontRequestsFor, googleFontsUrl } from "../../../web/src/design/fonts.ts";

let cached: DesignConfig | null = null;

function fallbackDesign(): DesignConfig {
  const preset = findPreset("clean");
  if (!preset) throw new Error('design-head: the "clean" preset is missing');
  return preset.design;
}

/** The project's design config (memoized). Never throws for a bad file. */
export function currentDesign(): DesignConfig {
  if (cached) return cached;
  try {
    cached = checkDesign(JSON.parse(Deno.readTextFileSync(DESIGN_FILE_PATH))).design;
  } catch (err) {
    log.error(
      "design.json could not be read for SSR pages; using the clean preset",
      { source: "ssr", feature: "design-head" },
      err instanceof Error ? err : new Error(String(err)),
    );
    cached = fallbackDesign();
  }
  return cached;
}

/** The `<head>` markup that carries the design: fonts link + token stylesheet. */
export function designHead(design: DesignConfig = currentDesign()): string {
  const fontsUrl = googleFontsUrl(fontRequestsFor(design.fonts));
  return [
    `<link rel="preconnect" href="https://fonts.googleapis.com" />`,
    `<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />`,
    `<link rel="stylesheet" href="${escapeHtml(fontsUrl)}" />`,
    // A "</" in a font name must not end the style element early.
    `<style id="design-tokens">${designStylesheet(design).replace(/<\//g, "<\\/")}</style>`,
  ].join("\n");
}

/** `<html>` attributes for the design, with a leading space. */
export function designHtmlAttributes(design: DesignConfig = currentDesign()): string {
  return ` data-radius-scale="${escapeHtml(RADIUS_SCALE_LABEL[design.shape.radius])}"` +
    ` data-design-mode="${escapeHtml(design.mode)}"` +
    ` data-design-preset="${escapeHtml(design.preset ?? "custom")}"`;
}

/** Test seam: forget the memoized design so the next call re-reads the file. */
export function __resetDesignCacheForTests(): void {
  cached = null;
}
