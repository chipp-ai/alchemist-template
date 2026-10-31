// Tests for src/lib/redirects.ts (chipp/redirects.json validation and
// matching). Run with: npm test. The Deno server tests cover serving.
import { test } from "node:test";
import assert from "node:assert/strict";
import { redirectKey, redirectLocation, redirectTable, validateRedirects } from "../src/lib/redirects.ts";

const r = (from, to, status = 301) => ({ from, to, status });

test("a valid file passes, including a chain and an off-site target", () => {
  assert.deepEqual(
    validateRedirects({ redirects: [r("/a", "/b"), r("/b", "/c/", 302), r("/old-shop", "https://shop.example.com/")] }),
    [],
  );
  assert.deepEqual(validateRedirects({ redirects: [] }), []);
});

test("the file must be an object with a redirects list", () => {
  assert.equal(validateRedirects([]).length, 1);
  assert.equal(validateRedirects({ rules: [] }).length, 1);
  assert.equal(validateRedirects(null).length, 1);
});

test("from must be a site path", () => {
  for (const from of ["old", "https://old.example.com/a", "//evil.test/a", "/a b", 7]) {
    const problems = validateRedirects({ redirects: [r(from, "/b")] });
    assert.ok(problems.some((p) => p.includes('"from" must be a site path')), `${from}: ${problems}`);
  }
});

test("to must be a site path or an http(s) URL", () => {
  for (const to of ["javascript:alert(1)", "b", "//evil.test", ""]) {
    const problems = validateRedirects({ redirects: [r("/a", to)] });
    assert.ok(problems.some((p) => p.includes('"to" must be')), `${to}: ${problems}`);
  }
});

test("status must be 301 or 302", () => {
  for (const status of [307, 308, 200, "301", null]) {
    const problems = validateRedirects({ redirects: [r("/a", "/b", status)] });
    assert.ok(problems.some((p) => p.includes('"status" must be 301 or 302')), String(status));
  }
});

test("duplicates and self-redirects are refused, with and without the trailing slash", () => {
  assert.ok(validateRedirects({ redirects: [r("/a", "/b"), r("/a/", "/c")] }).some((p) => p.includes("already redirected")));
  assert.ok(validateRedirects({ redirects: [r("/a", "/a/")] }).some((p) => p.includes("redirects to itself")));
});

test("loops are found, once each", () => {
  const problems = validateRedirects({ redirects: [r("/a", "/b"), r("/b", "/c"), r("/c", "/a/"), r("/x", "/a")] });
  assert.deepEqual(problems, ["redirect loop: /a -> /b -> /c -> /a"]);
  assert.deepEqual(validateRedirects({ redirects: [r("/p", "/q?x=1"), r("/q", "/p")] }), ["redirect loop: /p -> /q -> /p"]);
});

test("matching ignores the trailing slash and the query; the query is carried over", () => {
  assert.equal(redirectKey("/About/"), "/About");
  assert.equal(redirectKey("/a/?x=1#y"), "/a");
  assert.equal(redirectKey("/"), "/");
  const table = redirectTable([r("/old/", "/new/"), r("/keep", "/new/?ref=old")]);
  assert.equal(table.get(redirectKey("/old"))?.to, "/new/");
  assert.equal(redirectLocation(table.get("/old"), "?utm_source=x"), "/new/?utm_source=x");
  assert.equal(redirectLocation(table.get("/keep"), "?utm_source=x"), "/new/?ref=old");
  assert.equal(redirectLocation(r("/s", "https://shop.example.com/"), "?a=1"), "https://shop.example.com/");
});
