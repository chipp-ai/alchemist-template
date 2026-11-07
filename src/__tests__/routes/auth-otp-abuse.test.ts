/**
 * Sign-in codes: the abuse limits on every route that mints or checks a code.
 *
 * Security passes on 148 projects re-found the same flaws in the template's
 * own sign-in code: the email-change confirm read the try count, compared,
 * then incremented (parallel guesses slipped past the cap); no route had a
 * per-IP limit; the email-change request minted fresh 5-try codes with no
 * limit at all; and a resend kept a code alive forever.
 */
import { assert, assertEquals } from "@std/assert";
import { createIsolatedUser, dbTest, withTestServer } from "../helpers.ts";
import {
  _setAuthRateLimiterForTest,
  authRoutes,
  OTP_LIMITS,
  OTP_MAX_ATTEMPTS,
  OTP_MAX_LIFE_MINUTES,
} from "@/api/routes/auth/index.ts";
import { createSessionToken } from "@/api/middleware/auth.ts";
import { db } from "@/db/client.ts";
import { sql } from "kysely";

function buildApp() {
  return withTestServer((app) => app.route("/api/auth", authRoutes));
}

function post(
  app: ReturnType<typeof buildApp>,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
) {
  return app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function freshEmail(): string {
  return `otp-abuse-${crypto.randomUUID().slice(0, 8)}@example.com`;
}

async function rowsFor(email: string) {
  return await db.selectFrom("otps").select(["otpCode", "attempts", "createdAt", "expiresAt"])
    .where("email", "=", email).execute();
}

async function cleanupOtps(...emails: string[]) {
  for (const email of emails) {
    await db.deleteFrom("otps").where("email", "=", email).execute();
    const user = await db.selectFrom("users").select(["id", "organizationId"])
      .where("email", "=", email).executeTakeFirst();
    if (user) {
      await db.deleteFrom("users").where("id", "=", user.id).execute();
      if (user.organizationId) {
        await db.deleteFrom("organizations").where("id", "=", user.organizationId).execute();
      }
    }
  }
}

/** A fixed-window limiter in memory, the same contract as rateLimit() in redis.ts. */
function memoryLimiter() {
  const counts = new Map<string, number>();
  const fn = (name: string, opts: { limit: number }) => {
    const n = (counts.get(name) ?? 0) + 1;
    counts.set(name, n);
    return Promise.resolve({ allowed: n <= opts.limit });
  };
  return { fn, counts };
}

async function withLimiter(fn: (counts: Map<string, number>) => Promise<void>) {
  const limiter = memoryLimiter();
  _setAuthRateLimiterForTest(limiter.fn);
  try {
    await fn(limiter.counts);
  } finally {
    _setAuthRateLimiterForTest(null);
  }
}

async function signedIn() {
  const ctx = await createIsolatedUser("owner");
  const cookie = `session_id=${await createSessionToken(ctx.user)}`;
  return { ...ctx, cookie };
}

// ── Email change: the confirm step ──

dbTest(
  "email-change confirm: parallel wrong guesses cannot get past OTP_MAX_ATTEMPTS",
  async () => {
    const me = await signedIn();
    const email = freshEmail();
    const app = buildApp();
    try {
      assertEquals(
        (await post(app, "/api/auth/me/email-change", { email }, { cookie: me.cookie })).status,
        200,
      );
      const [{ otpCode: code }] = await rowsFor(email);
      const wrong = code === "000000" ? "111111" : "000000";

      const guesses = OTP_MAX_ATTEMPTS * 4;
      const responses = await Promise.all(
        Array.from(
          { length: guesses },
          () =>
            post(app, "/api/auth/me/email-change/confirm", { email, otpCode: wrong }, {
              cookie: me.cookie,
            }),
        ),
      );
      const messages = await Promise.all(responses.map(async (r) => {
        assertEquals(r.status, 401);
        return String((await r.json()).error);
      }));
      assertEquals(
        messages.filter((m) => m === "Invalid code").length,
        OTP_MAX_ATTEMPTS,
        "exactly OTP_MAX_ATTEMPTS guesses are compared",
      );
      assertEquals((await rowsFor(email)).map((r) => r.attempts), [OTP_MAX_ATTEMPTS]);

      // The right code arrives too late, and the spent row keeps its count.
      const late = await post(app, "/api/auth/me/email-change/confirm", { email, otpCode: code }, {
        cookie: me.cookie,
      });
      assertEquals(late.status, 401);
      assertEquals((await rowsFor(email)).map((r) => r.attempts), [OTP_MAX_ATTEMPTS]);
      const user = await db.selectFrom("users").select("email").where("id", "=", me.user.id)
        .executeTakeFirstOrThrow();
      assertEquals(user.email, me.user.email, "the address did not change");
    } finally {
      await cleanupOtps(email);
      await me.cleanup();
    }
  },
);

dbTest("email-change confirm: the right code changes the address once", async () => {
  const me = await signedIn();
  const email = freshEmail();
  const app = buildApp();
  try {
    await post(app, "/api/auth/me/email-change", { email }, { cookie: me.cookie });
    const [{ otpCode: code }] = await rowsFor(email);
    const res = await post(app, "/api/auth/me/email-change/confirm", { email, otpCode: code }, {
      cookie: me.cookie,
    });
    assertEquals(res.status, 200);
    assertEquals((await res.json()).user.email, email);
    assertEquals(await rowsFor(email), [], "the used code is gone");
  } finally {
    await cleanupOtps(email);
    await me.cleanup();
  }
});

// ── Email change: the request step ──

dbTest("email-change request: a resend keeps the same code and its try count", async () => {
  const me = await signedIn();
  const email = freshEmail();
  const app = buildApp();
  try {
    await post(app, "/api/auth/me/email-change", { email }, { cookie: me.cookie });
    const [{ otpCode: code }] = await rowsFor(email);
    const wrong = code === "000000" ? "111111" : "000000";
    for (let i = 0; i < 3; i++) {
      await post(app, "/api/auth/me/email-change/confirm", { email, otpCode: wrong }, {
        cookie: me.cookie,
      });
    }
    assertEquals(
      (await post(app, "/api/auth/me/email-change", { email }, { cookie: me.cookie })).status,
      200,
    );
    const rows = await rowsFor(email);
    assertEquals(rows.map((r) => r.otpCode), [code], "a resend sends the same code");
    assertEquals(rows.map((r) => r.attempts), [3], "a resend never resets the tries");
  } finally {
    await cleanupOtps(email);
    await me.cleanup();
  }
});

dbTest("email-change request: shares the per-address limit with send-otp", async () => {
  const me = await signedIn();
  const email = freshEmail();
  const app = buildApp();
  try {
    await withLimiter(async () => {
      for (let i = 0; i < OTP_LIMITS.sendPerAddress.limit; i++) {
        assertEquals((await post(app, "/api/auth/send-otp", { email })).status, 200);
      }
      const res = await post(app, "/api/auth/me/email-change", { email }, { cookie: me.cookie });
      assertEquals(res.status, 429);
      assertEquals((await res.json()).code, "RATE_LIMITED");
    });
  } finally {
    await cleanupOtps(email);
    await me.cleanup();
  }
});

dbTest("email-change request: one user cannot mint codes for address after address", async () => {
  const me = await signedIn();
  const emails = Array.from({ length: OTP_LIMITS.emailChangePerUser.limit + 1 }, freshEmail);
  const app = buildApp();
  try {
    await withLimiter(async () => {
      const statuses: number[] = [];
      for (const email of emails) {
        const res = await post(app, "/api/auth/me/email-change", { email }, { cookie: me.cookie });
        await res.body?.cancel();
        statuses.push(res.status);
      }
      assertEquals(statuses.slice(0, -1).every((s) => s === 200), true, String(statuses));
      assertEquals(statuses.at(-1), 429);
      assertEquals(await rowsFor(emails.at(-1)!), [], "no code was minted past the limit");
    });
  } finally {
    await cleanupOtps(...emails);
    await me.cleanup();
  }
});

// ── Per-IP limits ──

dbTest("send-otp: one IP cannot mint codes for address after address", async () => {
  const emails = Array.from({ length: OTP_LIMITS.sendPerIp.limit + 1 }, freshEmail);
  const app = buildApp();
  try {
    await withLimiter(async (counts) => {
      const statuses: number[] = [];
      for (const email of emails) {
        const res = await post(app, "/api/auth/send-otp", { email }, {
          "cf-connecting-ip": "203.0.113.7",
        });
        await res.body?.cancel();
        statuses.push(res.status);
      }
      assertEquals(statuses.slice(0, -1).every((s) => s === 200), true, String(statuses));
      assertEquals(statuses.at(-1), 429);
      assertEquals(counts.get("otp-send:ip:203.0.113.7"), emails.length);

      // Another IP is not affected.
      const other = await post(app, "/api/auth/send-otp", { email: emails[0] }, {
        "cf-connecting-ip": "203.0.113.8",
      });
      assertEquals(other.status, 200);
    });
  } finally {
    await cleanupOtps(...emails);
  }
});

dbTest("send-otp: no edge IP means no shared per-IP bucket", async () => {
  const email = freshEmail();
  const app = buildApp();
  try {
    await withLimiter(async (counts) => {
      // X-Forwarded-For is written by the caller, so it is never the key.
      await post(app, "/api/auth/send-otp", { email }, { "x-forwarded-for": "198.51.100.1" });
      assertEquals([...counts.keys()].filter((k) => k.includes(":ip:")), []);
    });
  } finally {
    await cleanupOtps(email);
  }
});

dbTest("verify-otp and email-change confirm: limited per IP", async () => {
  const me = await signedIn();
  const email = freshEmail();
  const app = buildApp();
  const ip = { "cf-connecting-ip": "203.0.113.9" };
  try {
    await withLimiter(async () => {
      let last = 0;
      for (let i = 0; i <= OTP_LIMITS.verifyPerIp.limit; i++) {
        const target = freshEmail();
        const res = i % 2 === 0
          ? await post(app, "/api/auth/verify-otp", { email: target, otpCode: "123456" }, ip)
          : await post(app, "/api/auth/me/email-change/confirm", {
            email: target,
            otpCode: "123456",
          }, { ...ip, cookie: me.cookie });
        await res.body?.cancel();
        last = res.status;
      }
      assertEquals(last, 429);
      const res = await post(app, "/api/auth/verify-otp", { email, otpCode: "123456" }, ip);
      assertEquals(res.status, 429);
      assertEquals((await res.json()).code, "RATE_LIMITED");
    });
  } finally {
    await cleanupOtps(email);
    await me.cleanup();
  }
});

// ── Code life ──

dbTest("send-otp: a resend never keeps a code alive past OTP_MAX_LIFE_MINUTES", async () => {
  const email = freshEmail();
  const app = buildApp();
  try {
    await post(app, "/api/auth/send-otp", { email });
    const createdAt = new Date(Date.now() - (OTP_MAX_LIFE_MINUTES - 10) * 60_000);
    await sql`UPDATE otps SET created_at = ${createdAt} WHERE email = ${email}`.execute(db);

    await post(app, "/api/auth/send-otp", { email });
    const [row] = await rowsFor(email);
    const cap = createdAt.getTime() + OTP_MAX_LIFE_MINUTES * 60_000;
    assert(
      new Date(row.expiresAt).getTime() <= cap + 1000,
      `expires ${new Date(row.expiresAt).toISOString()}, cap ${new Date(cap).toISOString()}`,
    );
  } finally {
    await cleanupOtps(email);
  }
});
