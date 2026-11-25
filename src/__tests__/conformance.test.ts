/**
 * `deno task conformance` (scripts/conformance.ts): the template itself must
 * pass with no errors, and a stack swap must be an error while smaller drift
 * is a warning. The Chipp build runs a byte-identical copy of the script, so
 * these cases are also what the publish gate does.
 */
import { assert, assertEquals } from "@std/assert";
import { packageOf, runConformance } from "../../scripts/conformance.ts";

const root = new URL("../../", import.meta.url).pathname;

Deno.test("conformance: the template has no errors", async () => {
  const report = await runConformance({ root });
  assertEquals(report.errors.map((e) => e.key), []);
  assert(report.ok);
});

Deno.test("conformance: specifiers resolve to package names", () => {
  assertEquals(packageOf("npm:@sentry/deno@8.1.0/sub"), "@sentry/deno");
  assertEquals(packageOf("https://deno.land/x/oak@v12/mod.ts"), "deno.land/x/oak");
  assertEquals(packageOf("https://esm.sh/react@18"), "react");
  assertEquals(packageOf("jsr:@std/log@0.224"), "@std/log");
  assertEquals(packageOf("./local.ts"), null);
  assertEquals(packageOf("@/lib/logger.ts"), null);
});

Deno.test("conformance: a stack swap is an error, drift is a warning, the baseline grandfathers", async () => {
  const dir = await Deno.makeTempDir({ prefix: "conformance-" });
  try {
    await Deno.mkdir(`${dir}/src/services`, { recursive: true });
    await Deno.writeTextFile(
      `${dir}/deno.json`,
      JSON.stringify({ imports: { express: "npm:express@4", hono: "npm:hono@4" } }),
    );
    await Deno.writeTextFile(`${dir}/main.ts`, 'import express from "express";\n');
    await Deno.writeTextFile(`${dir}/src/services/a.ts`, 'console.log("hi");\n');

    const report = await runConformance({ root: dir });
    const errors = report.errors.map((e) => e.key);
    assert(errors.includes("stack.web-framework:express"));
    assert(errors.includes("core.missing:app.ts"));
    assert(errors.includes("core.bypassed:main.ts"));
    assert(!errors.some((k) => k.includes("hono")), "hono is the template's own framework");
    assert(report.warnings.some((w) => w.key === "drift.console:src/services/a.ts"));
    assertEquals(report.ok, false);

    const old = await runConformance({ root: dir, baseline: new Set(errors) });
    assert(old.ok, "errors already live before the check do not block");
    assertEquals(old.grandfathered, errors);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
