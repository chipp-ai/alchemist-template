import { assertEquals } from "@std/assert";
import { withTestServer } from "../helpers.ts";
import { infoRoutes } from "@/api/routes/info/index.ts";

Deno.test("GET /api/info returns template + git_sha", async () => {
  const app = withTestServer((a) => {
    a.route("/api/info", infoRoutes);
  });

  const res = await app.request("/api/info");
  assertEquals(res.status, 200);

  const body = await res.json();
  assertEquals(body.template, "alchemist-template");
  assertEquals(typeof body.git_sha, "string");
  // The git_sha is captured at module-load time. In the test environment
  // GIT_SHA may or may not be set — assert non-empty and that it equals
  // either the env value or "dev".
  const expected = Deno.env.get("GIT_SHA") ?? "dev";
  assertEquals(body.git_sha, expected);
});
