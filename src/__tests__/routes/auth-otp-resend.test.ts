/**
 * Sign-in codes: email can be slow and people press Resend while they wait.
 * A resend sends the SAME live code, so every email in the inbox works.
 *
 * Before this, every send minted a new code and deleted the old one. During a
 * live event, attendees on a slow mail gateway pressed Resend many times, the
 * email they finally opened held a dead code, and the form said only
 * "Unauthorized".
 */
import { assert, assertEquals } from "@std/assert";
import { dbTest, withTestServer } from "../helpers.ts";
import { authRoutes, OTP_MAX_ATTEMPTS, OTP_TTL_MINUTES } from "@/api/routes/auth/index.ts";
import { db } from "@/db/client.ts";

function buildApp() {
  return withTestServer((app) => app.route("/api/auth", authRoutes));
}

function post(app: ReturnType<typeof buildApp>, path: string, body: unknown) {
  return app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function codesFor(email: string): Promise<string[]> {
  const rows = await db.selectFrom("otps").select("otpCode").where("email", "=", email)
    .orderBy("createdAt", "asc").execute();
  return rows.map((r) => r.otpCode);
}

async function cleanup(email: string) {
  await db.deleteFrom("otps").where("email", "=", email).execute();
  const user = await db.selectFrom("users").select(["id", "organizationId"]).where(
    "email",
    "=",
    email,
  )
    .executeTakeFirst();
  if (user) {
    await db.deleteFrom("users").where("id", "=", user.id).execute();
    if (user.organizationId) {
      await db.deleteFrom("organizations").where("id", "=", user.organizationId).execute();
    }
  }
}

function freshEmail(): string {
  return `otp-${crypto.randomUUID().slice(0, 8)}@example.com`;
}

dbTest("otp: a resend sends the same code, never a second one", async () => {
  const email = freshEmail();
  const app = buildApp();
  try {
    for (let i = 0; i < 5; i++) {
      assertEquals((await post(app, "/api/auth/send-otp", { email })).status, 200);
    }
    assertEquals((await codesFor(email)).length, 1);
  } finally {
    await cleanup(email);
  }
});

dbTest(
  "otp: the first email still signs in after resends, and a pasted code with a space works",
  async () => {
    const email = freshEmail();
    const app = buildApp();
    try {
      await post(app, "/api/auth/send-otp", { email });
      const [first] = await codesFor(email);
      await post(app, "/api/auth/send-otp", { email });
      await post(app, "/api/auth/send-otp", { email });

      const spaced = `${first.slice(0, 3)} ${first.slice(3)}`;
      const res = await post(app, "/api/auth/verify-otp", { email, otpCode: spaced });
      assertEquals(res.status, 200);
      assertEquals((await codesFor(email)).length, 0, "a used code is gone");
    } finally {
      await cleanup(email);
    }
  },
);

dbTest("otp: a code lives OTP_TTL_MINUTES, and a resend extends it", async () => {
  const email = freshEmail();
  const app = buildApp();
  try {
    await post(app, "/api/auth/send-otp", { email });
    await db.updateTable("otps").set({ expiresAt: new Date(Date.now() + 60_000) }).where(
      "email",
      "=",
      email,
    )
      .execute();
    await post(app, "/api/auth/send-otp", { email });
    const row = await db.selectFrom("otps").select("expiresAt").where("email", "=", email)
      .executeTakeFirstOrThrow();
    const minutes = (new Date(row.expiresAt).getTime() - Date.now()) / 60000;
    assert(minutes > OTP_TTL_MINUTES - 2 && minutes <= OTP_TTL_MINUTES, `got ${minutes} minutes`);
  } finally {
    await cleanup(email);
  }
});

dbTest("otp: an expired code says so, in words the person can act on", async () => {
  const email = freshEmail();
  const app = buildApp();
  try {
    await post(app, "/api/auth/send-otp", { email });
    const [code] = await codesFor(email);
    await db.updateTable("otps").set({ expiresAt: new Date(Date.now() - 1000) }).where(
      "email",
      "=",
      email,
    )
      .execute();
    const res = await post(app, "/api/auth/verify-otp", { email, otpCode: code });
    assertEquals(res.status, 401);
    assert(String((await res.json()).error).includes("expired"));

    // The next send issues a fresh code that works.
    await post(app, "/api/auth/send-otp", { email });
    const [fresh] = await codesFor(email);
    assertEquals((await post(app, "/api/auth/verify-otp", { email, otpCode: fresh })).status, 200);
  } finally {
    await cleanup(email);
  }
});

dbTest(
  "otp: a wrong code is refused with the tries left, and OTP_MAX_ATTEMPTS misses spend it",
  async () => {
    const email = freshEmail();
    const app = buildApp();
    try {
      await post(app, "/api/auth/send-otp", { email });
      const [code] = await codesFor(email);
      const wrong = code === "000000" ? "111111" : "000000";
      const firstMiss = await post(app, "/api/auth/verify-otp", { email, otpCode: wrong });
      assertEquals(firstMiss.status, 401);
      assert(String((await firstMiss.json()).error).includes(`${OTP_MAX_ATTEMPTS - 1} tries left`));
      for (let i = 1; i < OTP_MAX_ATTEMPTS; i++) {
        assertEquals(
          (await post(app, "/api/auth/verify-otp", { email, otpCode: wrong })).status,
          401,
        );
      }
      // Spent: even the right code no longer works, and a resend mints a new one.
      assertEquals((await post(app, "/api/auth/verify-otp", { email, otpCode: code })).status, 401);
      await post(app, "/api/auth/send-otp", { email });
      assertEquals((await codesFor(email)).length, 1);
    } finally {
      await cleanup(email);
    }
  },
);

dbTest("otp: a code left from an older deploy still works next to the live one", async () => {
  const email = freshEmail();
  const app = buildApp();
  try {
    const expiresAt = new Date(Date.now() + 5 * 60_000);
    await db.insertInto("otps").values({ email, otpCode: "246810", expiresAt }).execute();
    await db.insertInto("otps").values({ email, otpCode: "135791", expiresAt }).execute();
    assertEquals(
      (await post(app, "/api/auth/verify-otp", { email, otpCode: "246810" })).status,
      200,
    );
    assertEquals((await codesFor(email)).length, 0);
  } finally {
    await cleanup(email);
  }
});
