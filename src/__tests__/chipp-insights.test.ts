/**
 * Unit tests for Chipp Insights:
 *   - src/lib/chipp-insights.ts (chipp-insights.json parsing/validation)
 *   - src/api/middleware/chipp-insights.ts (beacon <script> injection)
 *
 * The middleware is built via `createChippInsightsMiddleware(config)` so
 * tests can inject a config directly instead of writing a real
 * `chipp-insights.json` to disk -- mirrors the fixture-injection style of
 * `demo-banner.test.ts`, adapted for a file-backed (not env-var-backed)
 * config.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { Hono } from "hono";
import { parseChippInsightsConfig } from "@/lib/chipp-insights.ts";
import { createChippInsightsMiddleware } from "@/api/middleware/chipp-insights.ts";

// ── parseChippInsightsConfig ─────────────────────────────────────────────

Deno.test("parseChippInsightsConfig: accepts a valid telemetryPublicKey", () => {
  const config = parseChippInsightsConfig('{"telemetryPublicKey":"tk_pub_abc123"}');
  assertEquals(config, { telemetryPublicKey: "tk_pub_abc123" });
});

Deno.test("parseChippInsightsConfig: null on missing telemetryPublicKey", () => {
  assertEquals(parseChippInsightsConfig("{}"), null);
});

Deno.test("parseChippInsightsConfig: null on empty telemetryPublicKey", () => {
  assertEquals(parseChippInsightsConfig('{"telemetryPublicKey":""}'), null);
  assertEquals(parseChippInsightsConfig('{"telemetryPublicKey":"   "}'), null);
});

Deno.test("parseChippInsightsConfig: null on non-string telemetryPublicKey", () => {
  assertEquals(parseChippInsightsConfig('{"telemetryPublicKey":123}'), null);
  assertEquals(parseChippInsightsConfig('{"telemetryPublicKey":null}'), null);
});

Deno.test("parseChippInsightsConfig: null on malformed JSON", () => {
  assertEquals(parseChippInsightsConfig("not json"), null);
  assertEquals(parseChippInsightsConfig(""), null);
});

Deno.test("parseChippInsightsConfig: null when the JSON is a non-object (array/string/number)", () => {
  assertEquals(parseChippInsightsConfig("[]"), null);
  assertEquals(parseChippInsightsConfig('"tk_pub_abc123"'), null);
  assertEquals(parseChippInsightsConfig("42"), null);
  assertEquals(parseChippInsightsConfig("null"), null);
});

// ── chippInsightsMiddleware ───────────────────────────────────────────────

function buildTestApp(config: { telemetryPublicKey: string } | null) {
  const app = new Hono();
  app.use("*", createChippInsightsMiddleware(config));
  app.get(
    "/page",
    (c) =>
      c.html(
        "<!doctype html><html><head><title>x</title></head><body><h1>Hello</h1></body></html>",
      ),
  );
  app.get("/no-head", (c) => c.html("<div>not a full document</div>"));
  app.get("/data.json", (c) => c.json({ ok: true }));
  return app;
}

Deno.test("chippInsightsMiddleware: no-op (no script tag) when config is null", async () => {
  const app = buildTestApp(null);
  const res = await app.request("/page");
  const body = await res.text();
  assert(!body.includes("build.chipp.ai"), "beacon must be absent with no config");
  assertStringIncludes(body, "<h1>Hello</h1>");
});

Deno.test("chippInsightsMiddleware: injects the beacon script before </head> when config is present", async () => {
  const app = buildTestApp({ telemetryPublicKey: "tk_pub_abc123" });
  const res = await app.request("/page");
  const body = await res.text();
  assertStringIncludes(body, 'src="https://build.chipp.ai/i/beacon.js"');
  assertStringIncludes(body, 'data-project-key="tk_pub_abc123"');
  assertStringIncludes(body, "async");
  // Must land BEFORE </head>, after the rest of <head>'s content.
  assert(body.indexOf("build.chipp.ai") < body.indexOf("</head>"));
  assert(body.indexOf("<title>x</title>") < body.indexOf("build.chipp.ai"));
});

Deno.test("chippInsightsMiddleware: escapes the key when injecting into the attribute", async () => {
  const app = buildTestApp({ telemetryPublicKey: 'tk_pub_"><script>alert(1)</script>' });
  const res = await app.request("/page");
  const body = await res.text();
  assert(!body.includes('"><script>alert(1)</script>'), "raw key must not appear unescaped");
  assertStringIncludes(body, "&quot;&gt;&lt;script&gt;");
});

Deno.test("chippInsightsMiddleware: does not touch non-HTML (JSON) responses", async () => {
  const app = buildTestApp({ telemetryPublicKey: "tk_pub_abc123" });
  const res = await app.request("/data.json");
  const json = await res.json();
  assertEquals(json, { ok: true });
});

Deno.test("chippInsightsMiddleware: leaves a document with no </head> untouched", async () => {
  const app = buildTestApp({ telemetryPublicKey: "tk_pub_abc123" });
  const res = await app.request("/no-head");
  const body = await res.text();
  assertEquals(body, "<div>not a full document</div>");
});

Deno.test("chippInsightsMiddleware: preserves headers set by middleware registered earlier (outer wrap)", async () => {
  // Mirrors app.ts: other response-mutating middleware wraps OUTSIDE this
  // one. Reassigning c.res inside chippInsightsMiddleware must not drop
  // headers set by middleware registered before it in the chain.
  const app = new Hono();
  app.use("*", async (c, next) => {
    await next();
    c.header("X-Test-Header", "present");
  });
  app.use("*", createChippInsightsMiddleware({ telemetryPublicKey: "tk_pub_abc123" }));
  app.get(
    "/page",
    (c) => c.html("<!doctype html><html><head></head><body><p>hi</p></body></html>"),
  );

  const res = await app.request("/page");
  assertEquals(res.headers.get("X-Test-Header"), "present");
  const body = await res.text();
  assertStringIncludes(body, "build.chipp.ai");
});
