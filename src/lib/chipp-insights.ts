/**
 * Chipp Insights -- first-party analytics beacon config.
 *
 * Every project generated from this template ships with a tiny beacon
 * (https://build.chipp.ai/i/beacon.js) that Alchemist activates by
 * committing `chipp-insights.json` to the repo root at generation time,
 * shaped `{"telemetryPublicKey": "tk_pub_..."}`. This module is the SINGLE
 * place that reads and validates that file.
 *
 * # The contract
 *
 * - Present + valid key -> `CHIPP_INSIGHTS_CONFIG` is a non-null config.
 *   `src/api/middleware/chipp-insights.ts` injects the beacon `<script>`
 *   tag into every HTML response.
 * - Absent, unreadable, malformed JSON, or an empty/non-string key ->
 *   `CHIPP_INSIGHTS_CONFIG` is `null`. This is an EXPECTED, common state
 *   (minting can fail, or a checkout of this template predates the
 *   contract entirely) -- not a bug, so nothing here throws or logs at
 *   warn/error level.
 *
 * Read once at module load: the file is written at repo-generation time
 * and never changes for the life of a running pod, so there is no reason
 * to re-read it per request.
 */

export interface ChippInsightsConfig {
  readonly telemetryPublicKey: string;
}

/**
 * Parses already-read JSON text into a config, or `null` if the shape is
 * missing/invalid. Pure function (no filesystem access) so it can be unit
 * tested directly without touching disk.
 */
export function parseChippInsightsConfig(raw: string): ChippInsightsConfig | null {
  try {
    const parsed = JSON.parse(raw);
    const key = parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>).telemetryPublicKey
      : undefined;
    if (typeof key !== "string" || key.trim() === "") return null;
    return { telemetryPublicKey: key };
  } catch {
    return null;
  }
}

/** Reads `chipp-insights.json` from the repo root. Never throws. */
function loadChippInsightsConfigFromDisk(): ChippInsightsConfig | null {
  try {
    const raw = Deno.readTextFileSync(new URL("../../chipp-insights.json", import.meta.url));
    return parseChippInsightsConfig(raw);
  } catch {
    // Missing file, permission error, etc. -- all fall into the same
    // "inert" outcome as a malformed file. See module doc above.
    return null;
  }
}

export const CHIPP_INSIGHTS_CONFIG: ChippInsightsConfig | null = loadChippInsightsConfigFromDisk();
