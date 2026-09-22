/**
 * Design service — read, validate and write web/src/design/design.json.
 *
 * The design config is the SPA's concern (web/src/design/), but the API
 * owns the file on disk so the /#/design page's "Save to project" button
 * and the platform's chat agent have one validated write path instead of
 * each editing JSON by hand. Dev-only in practice: the routes that call
 * this live under /api/dev and the write needs --allow-write, which only
 * `deno task dev` grants.
 *
 * The design modules under web/src/design/ are plain, dependency-free
 * TypeScript precisely so this file can import them from Deno.
 */

import { z } from "zod";
import { BadRequestError } from "@/utils/errors.ts";
import { log } from "@/lib/logger.ts";
import type { DesignConfig } from "../../web/src/design/types.ts";
import {
  DENSITIES,
  HEADING_CASES,
  RADIUS_PRESETS,
  SHADOW_PRESETS,
} from "../../web/src/design/types.ts";
import { DESIGN_PRESETS, findPreset, matchPresets } from "../../web/src/design/presets.ts";
import { findFont, FONT_CATALOG } from "../../web/src/design/fonts.ts";
import {
  type DesignIssue,
  designToCssVars,
  hasErrors,
  validateDesign,
} from "../../web/src/design/tokens.ts";

export type { DesignConfig, DesignIssue };
export { DESIGN_PRESETS, findPreset, FONT_CATALOG, matchPresets };

/** Absolute path of the project's design file. */
export const DESIGN_FILE_PATH =
  new URL("../../web/src/design/design.json", import.meta.url).pathname;

const hex = z.string().regex(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i, "must be a hex colour like #4f46e5");

export const designSchema = z.object({
  version: z.literal(1),
  preset: z.string().min(1).max(64).nullable(),
  name: z.string().trim().min(1).max(80),
  mode: z.enum(["light", "dark"]),
  fonts: z.object({
    heading: z.string().trim().min(1).max(80),
    body: z.string().trim().min(1).max(80),
    mono: z.string().trim().min(1).max(80),
    headingWeight: z.number().int().min(300).max(900),
    bodyWeight: z.number().int().min(300).max(600),
  }).strict(),
  colors: z.object({
    primary: hex,
    accent: hex,
    background: hex,
    surface: hex,
    text: hex,
    success: hex.optional(),
    warning: hex.optional(),
    danger: hex.optional(),
  }).strict(),
  shape: z.object({
    radius: z.enum(RADIUS_PRESETS as [string, ...string[]]),
    borderWidth: z.union([z.literal(1), z.literal(2)]),
    shadow: z.enum(SHADOW_PRESETS as [string, ...string[]]),
  }).strict(),
  type: z.object({
    baseSize: z.number().min(14).max(20),
    scale: z.number().min(1.1).max(1.5),
    headingTracking: z.number().min(-0.1).max(0.2),
    headingCase: z.enum(HEADING_CASES as [string, ...string[]]),
  }).strict(),
  density: z.enum(DENSITIES as [string, ...string[]]),
}).strict();

export type DesignInput = z.infer<typeof designSchema>;

/**
 * Parse + validate a candidate design. Throws BadRequestError with the
 * first readable problem; returns the config plus its warnings.
 */
export function checkDesign(candidate: unknown): { design: DesignConfig; issues: DesignIssue[] } {
  const parsed = designSchema.safeParse(candidate);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path?.length ? `${issue.path.join(".")}: ` : "";
    throw new BadRequestError(`Invalid design: ${where}${issue?.message ?? "malformed"}`);
  }
  const design = parsed.data as DesignConfig;
  const issues = validateDesign(design);
  if (hasErrors(issues)) {
    const first = issues.find((i) => i.level === "error")!;
    throw new BadRequestError(`Design fails a hard check (${first.code}): ${first.message}`);
  }
  return { design, issues };
}

export async function readDesign(path: string = DESIGN_FILE_PATH): Promise<DesignConfig> {
  const raw = await Deno.readTextFile(path);
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new BadRequestError(
      `design.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return checkDesign(json).design;
}

/** Validate and persist. Rejects designs with hard errors (unreadable text etc.). */
export async function writeDesign(
  candidate: unknown,
  path: string = DESIGN_FILE_PATH,
): Promise<{ design: DesignConfig; issues: DesignIssue[] }> {
  const { design, issues } = checkDesign(candidate);
  await Deno.writeTextFile(path, JSON.stringify(design, null, 2) + "\n");
  log.info("Design saved", {
    source: "design",
    preset: design.preset,
    name: design.name,
    fonts: `${design.fonts.heading} / ${design.fonts.body} / ${design.fonts.mono}`,
    warnings: issues.length,
  });
  return { design, issues };
}

/** Replace the project's design with a preset's, verbatim. */
export async function applyDesignPreset(
  id: string,
  path: string = DESIGN_FILE_PATH,
): Promise<{ design: DesignConfig; issues: DesignIssue[] }> {
  const preset = findPreset(id);
  if (!preset) {
    throw new BadRequestError(
      `Unknown preset "${id}". Available: ${DESIGN_PRESETS.map((p) => p.id).join(", ")}.`,
    );
  }
  return await writeDesign(preset.design, path);
}

/**
 * Everything a builder UI or an agent needs to reason about the design:
 * the current config, its warnings, the derived tokens, the presets and
 * the font catalog.
 */
export function describeDesign(design: DesignConfig) {
  const unknownFonts = (["heading", "body", "mono"] as const)
    .map((k) => design.fonts[k])
    .filter((f) => !findFont(f));
  return {
    design,
    issues: validateDesign(design),
    unknownFonts,
    cssVars: designToCssVars(design),
    presets: DESIGN_PRESETS.map(({ id, label, summary, vibe, suits, rationale }) => ({
      id,
      label,
      summary,
      vibe,
      suits,
      rationale,
    })),
    fonts: FONT_CATALOG,
    file: DESIGN_FILE_PATH,
  };
}
