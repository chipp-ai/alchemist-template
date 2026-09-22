/**
 * Design CLI — inspect and change web/src/design/design.json from a shell.
 *
 * The same validated path the /#/design page and the dev API use, for
 * agents working in a terminal:
 *
 *   deno task design list                      # presets with vibe words
 *   deno task design show                      # current design + warnings
 *   deno task design check                     # exit 1 on hard errors
 *   deno task design apply editorial           # replace design with a preset
 *   deno task design match "calm premium spa"  # rank presets for a phrase
 *   deno task design set fonts.heading Fraunces
 *   deno task design set colors.primary "#8b2e1f"
 *   deno task design set shape.radius pill
 *   deno task design fonts [sans|serif|display|mono]
 *
 * After any change: hard-reload the SPA (HMR is off) and open /#/design.
 */

import {
  applyDesignPreset,
  DESIGN_PRESETS,
  FONT_CATALOG,
  matchPresets,
  readDesign,
  writeDesign,
} from "@/services/design.service.ts";
import { validateDesign } from "../web/src/design/tokens.ts";

const [cmd = "show", ...rest] = Deno.args;

function coerce(value: string): unknown {
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null") return null;
  return value;
}

function setPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split(".");
  let cur: Record<string, unknown> = obj;
  for (const k of keys.slice(0, -1)) {
    if (typeof cur[k] !== "object" || cur[k] === null) cur[k] = {};
    cur = cur[k] as Record<string, unknown>;
  }
  cur[keys[keys.length - 1]] = value;
}

function printIssues(issues: { level: string; message: string }[]): void {
  for (const i of issues) console.log(`  ${i.level === "error" ? "ERROR" : "warn "}  ${i.message}`);
  if (issues.length === 0) console.log("  all checks pass (WCAG AA)");
}

try {
  switch (cmd) {
    case "list": {
      for (const p of DESIGN_PRESETS) {
        console.log(`${p.id.padEnd(10)} ${p.label.padEnd(20)} ${p.summary}`);
        console.log(`${"".padEnd(10)} vibe: ${p.vibe.join(", ")}`);
      }
      break;
    }
    case "show": {
      const design = await readDesign();
      console.log(JSON.stringify(design, null, 2));
      printIssues(validateDesign(design));
      break;
    }
    case "check": {
      const design = await readDesign();
      const issues = validateDesign(design);
      printIssues(issues);
      if (issues.some((i) => i.level === "error")) Deno.exit(1);
      break;
    }
    case "apply": {
      const id = rest[0];
      if (!id) throw new Error("usage: design apply <preset>");
      const { design, issues } = await applyDesignPreset(id);
      console.log(`applied preset "${id}" → ${design.name}`);
      printIssues(issues);
      break;
    }
    case "match": {
      const phrase = rest.join(" ");
      const hits = matchPresets(phrase);
      if (hits.length === 0) {
        console.log("no preset matched; try: " + DESIGN_PRESETS.map((p) => p.id).join(", "));
      }
      for (const p of hits) console.log(`${p.id.padEnd(10)} ${p.summary}`);
      break;
    }
    case "set": {
      const [path, ...valueParts] = rest;
      const value = valueParts.join(" ");
      if (!path || !value) throw new Error("usage: design set <dot.path> <value>");
      const design = await readDesign() as unknown as Record<string, unknown>;
      setPath(design, path, coerce(value));
      // Any manual edit makes it a custom design.
      if (!path.startsWith("preset") && !path.startsWith("name")) design.preset = null;
      const result = await writeDesign(design);
      console.log(`set ${path} = ${value}`);
      printIssues(result.issues);
      break;
    }
    case "fonts": {
      const cat = rest[0];
      for (const f of FONT_CATALOG) {
        if (cat && f.category !== cat) continue;
        console.log(
          `${f.category.padEnd(8)} ${f.family.padEnd(22)} ${
            f.weights.join("/").padEnd(20)
          } ${f.note}`,
        );
      }
      break;
    }
    default:
      console.error(`unknown command "${cmd}". See the header of scripts/design.ts.`);
      Deno.exit(2);
  }
} catch (err) {
  console.error(`[design] ${err instanceof Error ? err.message : String(err)}`);
  Deno.exit(1);
}
