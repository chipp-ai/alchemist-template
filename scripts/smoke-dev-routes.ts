/**
 * Smoke test for /api/dev/* — instant login + DB seed + reset.
 *
 * Drives the FULL agent path:
 *   1. spawn alchemist-builder sandbox
 *   2. clone alchemist-template, write .env, run db:migrate, start dev
 *   3. POST /api/dev/info (capability check)
 *   4. POST /api/dev/login (creates user + org, sets cookie)
 *   5. GET /api/auth/me with the cookie (proves it's a real session)
 *   6. POST /api/dev/seed (bulk users)
 *   7. POST /api/dev/reset (truncate)
 *
 * Zero Claude tokens spent. Run from /Users/hunterhodnett/code/alchemist-template.
 *
 * Usage:
 *   E2B_API_KEY=... GITHUB_TOKEN=... \
 *   deno run --env --allow-net --allow-env --allow-read --allow-run \
 *     scripts/smoke-dev-routes.ts
 */

import { Sandbox } from "npm:@e2b/code-interpreter@^1.0.0";

const E2B_API_KEY = Deno.env.get("E2B_API_KEY");
const GITHUB_TOKEN = Deno.env.get("GITHUB_TOKEN") ?? "";
if (!E2B_API_KEY) {
  console.error("E2B_API_KEY required");
  Deno.exit(1);
}
if (!GITHUB_TOKEN) {
  console.error("GITHUB_TOKEN required");
  Deno.exit(1);
}

const TEMPLATE = "alchemist-builder";

console.log(`Spawning ${TEMPLATE} sandbox...`);
const sandbox = await Sandbox.create(TEMPLATE, {
  apiKey: E2B_API_KEY,
  timeoutMs: 600_000,
});
console.log(`  sandbox id: ${sandbox.sandboxId}`);

async function run(label: string, cmd: string, t = 120_000) {
  console.log(`\n--- ${label} ---`);
  const r = await sandbox.commands.run(cmd, { timeoutMs: t });
  if (r.stdout) console.log(r.stdout.trimEnd());
  if (r.stderr && r.exitCode !== 0) console.error(`STDERR: ${r.stderr.trimEnd()}`);
  console.log(`  exit=${r.exitCode}`);
  return r;
}

try {
  // Boot PG/Redis.
  await run("start-local-services", "sudo /usr/local/bin/start-local-services.sh && echo OK");

  // Push the LOCAL alchemist-template (with the dev module added)
  // straight into the sandbox via tarball — no need to wait for a
  // GitHub push + clone round-trip while we're iterating.
  const tarPath = "/tmp/alch-template.tar.gz";
  const localTarBuf = await new Deno.Command("tar", {
    args: [
      "--exclude=node_modules",
      "--exclude=web/dist",
      "--exclude=web/node_modules",
      "--exclude=.git",
      "--exclude=.scratch",
      "--exclude=._*", // macOS AppleDouble files break the migration runner
      "-czf",
      "-",
      "-C",
      "/Users/hunterhodnett/code/alchemist-template",
      ".",
    ],
    env: { COPYFILE_DISABLE: "1" }, // BSD tar: don't copy macOS extended attrs
    stdout: "piped",
  }).output();
  if (!localTarBuf.success) {
    throw new Error("local tar failed: " + new TextDecoder().decode(localTarBuf.stderr));
  }
  console.log(`Tar built: ${localTarBuf.stdout.length} bytes`);
  await sandbox.files.write(tarPath, localTarBuf.stdout);

  await run(
    "Extract local alchemist-template",
    `mkdir -p /home/user/alchemist-template && tar -xzf ${tarPath} -C /home/user/alchemist-template`,
  );

  // Write .env with the same shape ensure_local_dev_server uses.
  const envContents = [
    "PORT=8000",
    "NODE_ENV=development",
    "APP_NAME=smoke-dev-routes",
    "GIT_SHA=dev",
    "DATABASE_URL=postgres://postgres:postgres@localhost:5432/app_dev",
    // Intentionally NOT setting TEST_DATABASE_URL — db/client.ts prefers
    // TEST_DATABASE_URL over DATABASE_URL, which would route the dev
    // server at the (un-migrated) app_test DB.
    "DB_POOL_MAX=5",
    "REDIS_URL=redis://localhost:6379",
    "JWT_SECRET=alchemist-sandbox-test-secret-do-not-use-in-prod-32bytes",
    "ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000",
    "EMAIL_FROM=test@example.dev",
    "SMTP_HOST=",
    "SMTP_PORT=465",
    "SMTP_USERNAME=",
    "SMTP_PASSWORD=",
    "",
  ].join("\n");
  await sandbox.files.write("/home/user/alchemist-template/.env", envContents);

  // Run db:migrate.
  await run(
    "deno task db:migrate",
    "cd /home/user/alchemist-template && deno task db:migrate 2>&1 | tail -25",
    180_000,
  );

  // Background dev server using the same daemon trick the production
  // tool uses.
  await run(
    "spawn dev server",
    `sudo /sbin/start-stop-daemon --start --background \
      --make-pidfile --pidfile /tmp/dev.pid \
      --chuid user:user \
      --chdir /home/user/alchemist-template \
      --no-close --startas /usr/local/bin/deno -- task dev \
      >> /tmp/dev.log 2>&1 && echo SPAWNED`,
  );

  // Poll /health until 200.
  console.log("\n--- waiting for /health ---");
  let healthy = false;
  for (let i = 0; i < 60; i++) {
    const r = await sandbox.commands.run(
      "curl -s -o /dev/null -w '%{http_code}' -m 3 http://localhost:8000/health 2>/dev/null || true",
      { timeoutMs: 5_000 },
    );
    if (r.stdout.trim() === "200") {
      console.log(`  /health 200 after ~${i * 2}s`);
      healthy = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 2_000));
  }
  if (!healthy) {
    const log = await sandbox.commands.run("tail -80 /tmp/dev.log", { timeoutMs: 5_000 });
    console.error(log.stdout);
    throw new Error("/health never returned 200");
  }

  // 0.5. Sanity-check the migration outcome — proves the schema/tables
  //      are visible in the DB the dev server connects to.
  await run(
    "psql introspect (post-migrate)",
    `psql -h localhost -U postgres -d app_dev -c "\\dn" -c "\\dt app.*" 2>&1 | head -30`,
  );

  // 1. /api/dev/info
  const info = await run(
    "GET /api/dev/info",
    `curl -sS -m 5 http://localhost:8000/api/dev/info`,
  );
  if (!info.stdout.includes('"enabled":true')) {
    throw new Error("dev/info did not advertise enabled=true");
  }

  // 2. /api/dev/login
  const login = await run(
    "POST /api/dev/login",
    `curl -sS -m 10 -X POST -H 'Content-Type: application/json' \
       -d '{"email":"agent@dev.local","name":"Agent Tester"}' \
       -c /tmp/jar.txt \
       http://localhost:8000/api/dev/login`,
  );
  const loginBody = JSON.parse(login.stdout);
  if (!loginBody.user?.id || !loginBody.organization?.id) {
    throw new Error("login response missing user/organization");
  }
  if (loginBody.session_cookie !== "session_id") {
    throw new Error("login did not set the canonical session cookie name");
  }
  console.log(`  ✓ created user=${loginBody.user.id} org=${loginBody.organization.id}`);

  // 3. Use the cookie to hit /api/auth/me — proves the session is real.
  const me = await run(
    "GET /api/auth/me with cookie",
    `curl -sS -m 5 -b /tmp/jar.txt http://localhost:8000/api/auth/me`,
  );
  const meBody = JSON.parse(me.stdout);
  if (meBody.user?.email !== "agent@dev.local") {
    throw new Error("auth/me did not return the dev-logged-in user");
  }
  console.log(`  ✓ /api/auth/me round-tripped the dev session`);

  // 4. Idempotent re-login (same email) → same user.
  const login2 = await run(
    "POST /api/dev/login again (same email)",
    `curl -sS -m 5 -X POST -H 'Content-Type: application/json' \
       -d '{"email":"agent@dev.local"}' \
       http://localhost:8000/api/dev/login`,
  );
  const login2Body = JSON.parse(login2.stdout);
  if (login2Body.user.id !== loginBody.user.id) {
    throw new Error("re-login created a duplicate user");
  }
  console.log(`  ✓ re-login is idempotent (returned the same user id)`);

  // 5. /api/dev/seed — bulk users.
  const seed = await run(
    "POST /api/dev/seed (3 users)",
    `curl -sS -m 10 -X POST -H 'Content-Type: application/json' \
       -d '{"users":[{"email":"a@dev.local"},{"email":"b@dev.local"},{"email":"c@dev.local"}]}' \
       http://localhost:8000/api/dev/seed`,
  );
  const seedBody = JSON.parse(seed.stdout);
  if (!seedBody.ok || seedBody.seeded.users.length !== 3) {
    throw new Error("seed did not create 3 users");
  }
  console.log(`  ✓ seeded 3 users + orgs`);

  // 6. /api/dev/reset.
  const reset = await run(
    "POST /api/dev/reset",
    `curl -sS -m 10 -X POST -H 'Content-Type: application/json' -d '{}' http://localhost:8000/api/dev/reset`,
  );
  const resetBody = JSON.parse(reset.stdout);
  if (!resetBody.ok || !Array.isArray(resetBody.truncated)) {
    throw new Error("reset response missing ok / truncated[]");
  }
  console.log(`  ✓ truncated ${resetBody.truncated.length} tables`);

  // 7. Confirm reset actually wiped DB rows (not just returned ok).
  //    /auth/me will return 200 with the cookie intact — the JWT carries
  //    its own claims so the fast path doesn't hit the DB. The right
  //    assertion is at the SQL level: after reset, app.users is empty
  //    until we re-login.
  const sqlCheck = await run(
    "psql count app.users post-reset",
    `psql -h localhost -U postgres -d app_dev -tAc "SELECT COUNT(*) FROM app.users"`,
  );
  if (sqlCheck.stdout.trim() !== "0") {
    throw new Error(`reset did not wipe app.users (rows=${sqlCheck.stdout.trim()})`);
  }
  console.log(`  ✓ post-reset: app.users is empty`);

  // 8. Re-login after reset creates a NEW user row (different id).
  const reLogin = await run(
    "POST /api/dev/login post-reset",
    `curl -sS -m 5 -X POST -H 'Content-Type: application/json' \
       -d '{"email":"agent@dev.local"}' http://localhost:8000/api/dev/login`,
  );
  const reLoginBody = JSON.parse(reLogin.stdout);
  if (reLoginBody.user.id === loginBody.user.id) {
    throw new Error("post-reset login reused the old user id (it should be brand new)");
  }
  console.log(`  ✓ post-reset re-login created a fresh user (${reLoginBody.user.id})`);

  // 8. Production guard: spoof NODE_ENV=production via re-exec, hit /info.
  //    We can't restart the dev server easily mid-test, so just verify
  //    the guard logic locally by checking the source file shape.
  const grep = await run(
    "grep IS_PROD guard",
    `grep -E 'IS_PROD|NODE_ENV.*production' /home/user/alchemist-template/src/api/routes/dev/index.ts | head -5`,
  );
  if (!grep.stdout.includes("IS_PROD")) {
    throw new Error("dev module does not include IS_PROD guard");
  }
  console.log(`  ✓ production guard present in source`);

  console.log("\n=== ALL CHECKS PASSED ===");
} catch (err) {
  console.error("\n=== SMOKE TEST FAILED ===");
  console.error(err);
  try {
    const log = await sandbox.commands.run("tail -120 /tmp/dev.log 2>/dev/null || true", { timeoutMs: 5_000 });
    console.error("\n--- /tmp/dev.log ---");
    console.error(log.stdout);
  } catch { /* ignore */ }
  Deno.exit(1);
} finally {
  await sandbox.kill();
  console.log(`\n(sandbox ${sandbox.sandboxId} killed)`);
}
