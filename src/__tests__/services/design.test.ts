/**
 * Design system — presets, tokens, font catalog, and the validated
 * read/write path. Pure except for the temp-file round trip.
 */

import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  applyDesignPreset,
  checkDesign,
  designSchema,
  readDesign,
  writeDesign,
} from "@/services/design.service.ts";
import { DESIGN_PRESETS, findPreset, matchPresets } from "../../../web/src/design/presets.ts";
import {
  findFont,
  FONT_CATALOG,
  fontRequestsFor,
  fontStack,
  googleFontsUrl,
  nearestWeight,
} from "../../../web/src/design/fonts.ts";
import {
  bestTextOn,
  contrastRatio,
  designToCssVars,
  hasErrors,
  mix,
  typeScale,
  validateDesign,
} from "../../../web/src/design/tokens.ts";
import type { DesignConfig } from "../../../web/src/design/types.ts";
import { BadRequestError } from "@/utils/errors.ts";

const clean = findPreset("clean")!.design;

Deno.test("presets: every preset parses, passes hard checks, and uses catalog fonts", () => {
  assert(DESIGN_PRESETS.length >= 8, "at least eight presets ship");
  const ids = new Set<string>();
  for (const p of DESIGN_PRESETS) {
    assert(!ids.has(p.id), `duplicate preset id ${p.id}`);
    ids.add(p.id);
    assertEquals(p.design.preset, p.id);
    assert(designSchema.safeParse(p.design).success, `${p.id} fails the schema`);
    const issues = validateDesign(p.design);
    assert(
      !hasErrors(issues),
      `${p.id} has hard errors: ${issues.map((i) => i.message).join("; ")}`,
    );
    for (const slot of ["heading", "body", "mono"] as const) {
      assert(
        findFont(p.design.fonts[slot]),
        `${p.id}: ${slot} font "${p.design.fonts[slot]}" is not in the catalog`,
      );
    }
    assert(p.vibe.length >= 4, `${p.id} needs vibe words for matching`);
    assert(p.rationale.length > 80, `${p.id} needs a real rationale`);
  }
});

Deno.test("presets: button labels and text meet WCAG AA in every preset", () => {
  for (const p of DESIGN_PRESETS) {
    const c = p.design.colors;
    assert(contrastRatio(c.text, c.background) >= 4.5, `${p.id}: text on background`);
    assert(contrastRatio(c.text, c.surface) >= 4.5, `${p.id}: text on surface`);
    assert(contrastRatio(bestTextOn(c.primary), c.primary) >= 4.5, `${p.id}: label on primary`);
    // A drawn 2px border satisfies non-text contrast on its own (brutalist).
    assert(
      contrastRatio(c.primary, c.background) >= 3 || p.design.shape.borderWidth === 2,
      `${p.id}: primary on background`,
    );
    assertEquals(
      validateDesign(p.design).filter((i) => i.code === "contrast.primary-bg"),
      [],
      `${p.id} warns on primary`,
    );
  }
});

Deno.test("presets: matchPresets ranks by the user's words", () => {
  assertEquals(matchPresets("something bold, raw and brutalist")[0].id, "brutalist");
  assertEquals(matchPresets("a calm premium boutique feel")[0].id, "luxury");
  assertEquals(matchPresets("for a bank, very serious and corporate")[0].id, "corporate");
  assertEquals(matchPresets("zzz qqq"), []);
});

Deno.test("fonts: catalog families are unique with ascending weights", () => {
  const seen = new Set<string>();
  for (const f of FONT_CATALOG) {
    assert(!seen.has(f.family), `duplicate family ${f.family}`);
    seen.add(f.family);
    assert(f.weights.length > 0);
    for (let i = 1; i < f.weights.length; i++) {
      assert(f.weights[i] > f.weights[i - 1], `${f.family} weights unsorted`);
    }
    assert(f.note.length > 10);
  }
  assert(FONT_CATALOG.filter((f) => f.category === "mono").length >= 5);
  assert(FONT_CATALOG.filter((f) => f.category === "serif").length >= 8);
});

Deno.test("fonts: nearestWeight snaps to what the family ships", () => {
  assertEquals(nearestWeight("Archivo Black", 700), 400);
  assertEquals(nearestWeight("Lato", 600), 700);
  assertEquals(nearestWeight("Inter", 650), 600);
  assertEquals(nearestWeight("Unknown Family", 650), 700);
});

Deno.test("fonts: googleFontsUrl dedupes weights and encodes families", () => {
  const url = googleFontsUrl([
    { family: "Space Grotesk", weights: [700] },
    { family: "DM Sans", weights: [400, 500, 700] },
    { family: "DM Sans", weights: [400] },
  ]);
  assertEquals(
    url,
    "https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@700&family=DM+Sans:wght@400;500;700&display=swap",
  );
  const sub = googleFontsUrl([{ family: "Lora", weights: [400] }], { text: "Aa Lora" });
  assert(sub.includes("text=Aa%20Lora"));
});

Deno.test("fonts: fontRequestsFor requests exactly what the design renders", () => {
  const reqs = fontRequestsFor({
    heading: "Fraunces",
    body: "Source Sans 3",
    mono: "IBM Plex Mono",
    headingWeight: 650,
    bodyWeight: 400,
  });
  assertEquals(reqs[0], { family: "Fraunces", weights: [600] });
  assertEquals(reqs[1], { family: "Source Sans 3", weights: [400, 400, 600] });
  assertEquals(reqs[2], { family: "IBM Plex Mono", weights: [400, 500] });
  assert(fontStack("Fraunces").startsWith('"Fraunces", Georgia'));
  assert(fontStack("JetBrains Mono").includes("monospace"));
});

Deno.test("tokens: colour math", () => {
  assertEquals(Math.round(contrastRatio("#000000", "#ffffff")), 21);
  assertEquals(contrastRatio("#777777", "#777777"), 1);
  assertEquals(mix("#000000", "#ffffff", 0.5), "#808080");
  assertEquals(bestTextOn("#ffd23f"), "#111111");
  assertEquals(bestTextOn("#4f46e5"), "#ffffff");
  assertEquals(typeScale(1.2).lg, "1.2rem");
  assertEquals(typeScale(1.25)["2xl"], "1.953rem");
  assertEquals(typeScale(1.2).base, "1rem");
});

Deno.test("tokens: designToCssVars derives shape, mode and label colour", () => {
  const light = designToCssVars(clean);
  assertEquals(light["radius-control"], "8px");
  assertEquals(light["brand-primary-contrast"], "#ffffff");
  assertEquals(light["brand-radius-scale"], "soft");
  assertEquals(light["brand-font-heading"], '"Inter"');
  assertEquals(light["color-scheme"], "light");
  assert(light["font-heading"].startsWith('var(--brand-font-heading, "Inter"),'));
  assert(light["font-sans"].startsWith('var(--brand-font-body, "Inter"),'));

  const brutal = designToCssVars(findPreset("brutalist")!.design);
  assertEquals(brutal["radius-control"], "0px");
  assertEquals(brutal["border-width"], "2px");
  assertEquals(brutal["shadow-md"], "4px 4px 0 #111111");
  assertEquals(brutal["brand-primary-contrast"], "#111111");
  assertEquals(brutal["brand-radius-scale"], "sharp");
  assertEquals(brutal["heading-case"], "uppercase");

  const dark = designToCssVars(findPreset("dark")!.design);
  assertEquals(dark["color-scheme"], "dark");
  assertEquals(dark["color-bg"], "var(--brand-neutral)");
  // Muted text on a dark canvas must still be light.
  assert(contrastRatio(dark["color-muted"], "#0b0f14") > 4.5);

  const pill = designToCssVars(findPreset("friendly")!.design);
  assertEquals(pill["radius-control"], "9999px");
  assertEquals(pill["brand-radius-scale"], "round");
  const editorial = designToCssVars(findPreset("editorial")!.design);
  assert(
    editorial["font-heading"].includes("Georgia"),
    "serif heading gets a serif fallback stack",
  );
  assert(pill["radius-lg"] !== "9999px", "cards keep a finite radius under pill");
  assertEquals(designToCssVars(findPreset("luxury")!.design)["space-md"], "19px");
});

Deno.test("tokens: validateDesign flags unreadable text and bad values", () => {
  const bad: DesignConfig = structuredClone(clean);
  bad.colors.text = "#f8fafc"; // same as background
  const issues = validateDesign(bad);
  assert(issues.some((i) => i.code === "contrast.text-bg" && i.level === "error"));

  const notHex: DesignConfig = structuredClone(clean);
  notHex.colors.primary = "blue";
  assert(validateDesign(notHex).some((i) => i.code === "color.primary"));

  // #777777 is the mid-grey where neither a white nor a black label reaches 4.5:1.
  const lowContrastButton: DesignConfig = structuredClone(clean);
  lowContrastButton.colors.primary = "#777777";
  const warn = validateDesign(lowContrastButton);
  assert(warn.some((i) => i.code === "contrast.button-label" && i.level === "warn"));
  assert(!hasErrors(warn), "a weak button is a warning, not a block");
});

Deno.test("service: checkDesign rejects malformed and unreadable designs", () => {
  assertThrows(
    () => checkDesign({ ...clean, colors: { ...clean.colors, primary: "blue" } }),
    BadRequestError,
    "colors.primary",
  );
  assertThrows(() => checkDesign({ ...clean, extra: 1 }), BadRequestError);
  assertThrows(
    () => checkDesign({ ...clean, colors: { ...clean.colors, text: clean.colors.background } }),
    BadRequestError,
    "contrast.text-bg",
  );
  const ok = checkDesign(clean);
  assertEquals(ok.design.name, "Clean SaaS");
});

Deno.test("service: write / read round trip and preset apply on a temp file", async () => {
  const path = await Deno.makeTempFile({ suffix: ".json" });
  try {
    const { design } = await writeDesign(findPreset("editorial")!.design, path);
    assertEquals(design.fonts.heading, "Fraunces");
    const back = await readDesign(path);
    assertEquals(back, design);

    const applied = await applyDesignPreset("dark", path);
    assertEquals(applied.design.mode, "dark");
    assertEquals((await readDesign(path)).preset, "dark");

    await assertRejects(() => applyDesignPreset("nope", path), BadRequestError, "Unknown preset");
    await assertRejects(() => writeDesign({ nope: true }, path), BadRequestError);
    // A failed write leaves the file untouched.
    assertEquals((await readDesign(path)).preset, "dark");
  } finally {
    await Deno.remove(path);
  }
});

Deno.test("service: the shipped design.json is valid and matches a preset", async () => {
  const design = await readDesign();
  assert(!hasErrors(validateDesign(design)));
  if (design.preset) {
    assert(findPreset(design.preset), `design.json names unknown preset ${design.preset}`);
  }
});
