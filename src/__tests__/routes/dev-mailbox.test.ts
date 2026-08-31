/**
 * GET / DELETE /api/dev/mailbox -- the agent's window onto sent email.
 *
 * The gate is the important half. These endpoints expose message bodies
 * (OTP codes, invite links), so they must be dead unless the fail-closed
 * dev flag is set. They ride the same `devRoutes.use("*")` guard as
 * instant-login and DB reset; this file proves that guard covers them.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { withTestServer } from "../helpers.ts";
import { devRoutes } from "@/api/routes/dev/index.ts";
import { clearCapturedEmails, sendEmail } from "@/services/email.ts";

function deno(name: string, fn: () => void | Promise<void>) {
  Deno.test({ name, sanitizeResources: false, sanitizeOps: false, fn });
}

function buildApp() {
  return withTestServer((app) => {
    app.route("/api/dev", devRoutes);
  });
}

/** Set ALCHEMIST_DEV_ROUTES; returns a restore function for finally. */
function setDevRoutes(value: string | null): () => void {
  const prev = Deno.env.get("ALCHEMIST_DEV_ROUTES");
  if (value === null) Deno.env.delete("ALCHEMIST_DEV_ROUTES");
  else Deno.env.set("ALCHEMIST_DEV_ROUTES", value);
  return () => {
    if (prev === undefined) Deno.env.delete("ALCHEMIST_DEV_ROUTES");
    else Deno.env.set("ALCHEMIST_DEV_ROUTES", prev);
  };
}

/** Auth-critical so the communications gate never enters the picture. */
function send(to: string, subject: string, kind: string) {
  return sendEmail({ to, subject, text: subject, kind, authCritical: true });
}

deno("dev mailbox: 404s when the dev surface is off (fail closed)", async () => {
  const restore = setDevRoutes(null);
  try {
    const app = buildApp();
    assertEquals((await app.request("/api/dev/mailbox")).status, 404);
    assertEquals(
      (await app.request("/api/dev/mailbox", { method: "DELETE" })).status,
      404,
    );
  } finally {
    restore();
  }
});

deno("dev mailbox: 404s when the flag is set to something falsy", async () => {
  const restore = setDevRoutes("0");
  try {
    const app = buildApp();
    assertEquals((await app.request("/api/dev/mailbox")).status, 404);
  } finally {
    restore();
  }
});

deno("dev mailbox: returns captured email newest-last, with filters", async () => {
  const restore = setDevRoutes("1");
  try {
    clearCapturedEmails();
    const app = buildApp();

    await send("alpha@test.local", "Alpha subject", "route_alpha");
    await send("beta@test.local", "Beta subject", "route_beta");

    const res = await app.request("/api/dev/mailbox");
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.capturing, true);
    assertEquals(body.smtpConfigured, false);
    assertEquals(body.count, 2);
    assertEquals(body.emails[1].subject, "Beta subject");
    assertStringIncludes(body.emails[0].text, "Alpha");

    const filtered = await (await app.request("/api/dev/mailbox?kind=route_beta")).json();
    assertEquals(filtered.count, 1);
    assertEquals(filtered.emails[0].to, "beta@test.local");

    const byTo = await (await app.request("/api/dev/mailbox?to=ALPHA@test.local")).json();
    assertEquals(byTo.count, 1);

    const since = await (await app.request(
      `/api/dev/mailbox?since=${body.emails[0].seq}`,
    )).json();
    assertEquals(since.count, 1);
    assertEquals(since.emails[0].subject, "Beta subject");
  } finally {
    clearCapturedEmails();
    restore();
  }
});

deno("dev mailbox: a non-numeric `since` is a 400, not a silent full dump", async () => {
  const restore = setDevRoutes("1");
  try {
    const app = buildApp();
    const res = await app.request("/api/dev/mailbox?since=yesterday");
    assertEquals(res.status, 400);
  } finally {
    restore();
  }
});

deno("dev mailbox: DELETE empties the buffer", async () => {
  const restore = setDevRoutes("1");
  try {
    clearCapturedEmails();
    const app = buildApp();
    await send("clear-me@test.local", "Clear me", "route_clear");

    const del = await app.request("/api/dev/mailbox", { method: "DELETE" });
    assertEquals(del.status, 200);
    assertEquals((await del.json()).cleared >= 1, true);

    const after = await (await app.request("/api/dev/mailbox")).json();
    assertEquals(after.count, 0);
  } finally {
    clearCapturedEmails();
    restore();
  }
});
