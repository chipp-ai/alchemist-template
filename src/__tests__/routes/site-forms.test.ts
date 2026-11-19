/**
 * POST /api/site-forms/:name (src/api/routes/site-forms/index.ts): the
 * landing site's form sections. Validation against the form's own fields,
 * the honeypot, the rate limit, storage in site_form_submissions and the
 * owner email through the outbox.
 */
import { assert, assertEquals } from "@std/assert";
import { Hono } from "hono";
import { dbTest, getTestDb } from "../helpers.ts";
import { createSiteFormsRoutes, siteFormAttribution } from "@/api/routes/site-forms/index.ts";
import { parseCampaigns } from "../../../landing/src/lib/campaigns.ts";
import {
  loadSiteForms,
  type SiteFormEntry,
  siteFormRecipients,
  validateSubmission,
} from "@/services/site-forms.service.ts";
import { __deleteEnvForTest, __setEnvForTest } from "@/lib/env.ts";
import { PRODUCT_ENQUIRY_FORM, type SiteForm } from "../../../landing/src/lib/composed.ts";

const db = getTestDb();

function formNamed(name: string): SiteForm {
  return {
    name,
    fields: [
      { name: "name", label: "Your name", type: "text", required: true },
      { name: "email", label: "Email", type: "email", required: true },
      { name: "phone", label: "Phone", type: "tel" },
      {
        name: "service",
        label: "Service",
        type: "select",
        required: true,
        options: ["Repair", "Replacement"],
      },
      { name: "topics", label: "Topics", type: "checkboxes", options: ["Gutters", "Skylights"] },
      { name: "consent", label: "I agree", type: "checkbox", required: true },
      { name: "budget", label: "Budget", type: "number" },
      { name: "when", label: "Preferred date", type: "date" },
      { name: "site", label: "Website", type: "url" },
      { name: "message", label: "Message", type: "textarea", required: true },
      { name: "source", label: "Source", type: "hidden", value: "website" },
    ],
  };
}

const GOOD = {
  name: "Pat Visitor",
  email: "pat@example.com",
  service: "Repair",
  topics: ["Gutters", "Skylights"],
  consent: "yes",
  message: "My roof leaks over the kitchen.",
};

const CAMPAIGNS = parseCampaigns([{
  file: "src/content/campaigns/roof-storm.json",
  data: {
    name: "Storm damage, Meta ads",
    page: "/contact/",
    match: { utm_content: ["*storm*"] },
    hero: { headline: "Storm damage?" },
  },
}]).campaigns;

function app(form: SiteForm, opts: { limited?: boolean; recipients?: string[] } = {}): Hono {
  const entry: SiteFormEntry = { form, pagePath: "/contact/" };
  const root = new Hono();
  root.route(
    "/api/site-forms",
    createSiteFormsRoutes({
      forms: () => new Map([[form.name, entry]]),
      limiter: () => Promise.resolve({ allowed: !opts.limited }),
      recipients: () => Promise.resolve(opts.recipients ?? ["owner@example.com"]),
      campaigns: () => CAMPAIGNS,
    }),
  );
  return root;
}

function formBody(values: Record<string, string | string[]>): URLSearchParams {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(values)) {
    for (const x of Array.isArray(v) ? v : [v]) body.append(k, x);
  }
  return body;
}

const uniqueName = () => `contact-${crypto.randomUUID().slice(0, 8)}`;

async function rowsFor(formName: string) {
  return await db.selectFrom("site_form_submissions").selectAll().where("formName", "=", formName)
    .execute();
}

async function cleanup(formName: string): Promise<void> {
  const rows = await rowsFor(formName);
  for (const r of rows) {
    await db.deleteFrom("email_outbox").where("idempotencyKey", "like", `site-form:${r.id}:%`)
      .execute();
  }
  await db.deleteFrom("site_form_submissions").where("formName", "=", formName).execute();
}

Deno.test("site forms: validation keeps only the form's fields, typed", () => {
  const form = formNamed("contact");
  const ok = validateSubmission(form, {
    ...GOOD,
    budget: "1200.50",
    when: "2026-11-02",
    site: "https://pat.example.com",
    phone: "+1 (555) 010-0100",
    extra: "dropped",
    source: "tampered",
  });
  assert(ok.ok);
  assertEquals(ok.values, {
    name: "Pat Visitor",
    email: "pat@example.com",
    phone: "+1 (555) 010-0100",
    service: "Repair",
    topics: ["Gutters", "Skylights"],
    consent: true,
    budget: "1200.50",
    when: "2026-11-02",
    site: "https://pat.example.com",
    message: "My roof leaks over the kitchen.",
    source: "website",
  });
});

Deno.test("site forms: validation names every bad field", () => {
  const bad = validateSubmission(formNamed("contact"), {
    name: "  ",
    email: "not-an-email",
    service: "Painting",
    topics: ["Gutters", "Chimneys"],
    budget: "lots",
    when: "2026-02-30",
    site: "javascript:alert(1)",
    phone: "call me",
    message: "x".repeat(5001),
  });
  assert(!bad.ok);
  assertEquals(Object.keys(bad.errors).sort(), [
    "budget",
    "consent",
    "email",
    "message",
    "name",
    "phone",
    "service",
    "site",
    "topics",
    "when",
  ]);
});

Deno.test("site forms: loads form sections from the landing content pages", async () => {
  const dir = await Deno.makeTempDir({ prefix: "site-forms-pages-" });
  try {
    await Deno.mkdir(`${dir}/nested`);
    await Deno.writeTextFile(
      `${dir}/nested/contact.json`,
      JSON.stringify({
        path: "/contact",
        title: "Contact",
        sections: [{ type: "hero", heading: "Contact us" }, {
          type: "form",
          form: formNamed("contact"),
        }],
      }),
    );
    await Deno.writeTextFile(`${dir}/broken.json`, "{");
    await Deno.writeTextFile(`${dir}/invalid.json`, JSON.stringify({ path: "/x", sections: [] }));
    const forms = loadSiteForms(dir, `${dir}/no-products.json`);
    assertEquals([...forms.keys()], ["contact"]);
    assertEquals(forms.get("contact")?.pagePath, "/contact/");
    assertEquals(loadSiteForms(`${dir}/missing`, `${dir}/no-products.json`).size, 0);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("site forms: products.json with products registers the product enquiry form", async () => {
  const dir = await Deno.makeTempDir({ prefix: "site-forms-shop-" });
  try {
    const products = `${dir}/products.json`;
    const item = {
      id: "1",
      slug: "ring",
      path: "/product/ring/",
      title: "Ring",
      images: [],
      categories: [],
      tags: [],
    };
    await Deno.writeTextFile(
      products,
      JSON.stringify({ indexPath: "/store", currency: "USD", categories: [], items: [item] }),
    );
    const forms = loadSiteForms(`${dir}/pages`, products);
    assertEquals(forms.get(PRODUCT_ENQUIRY_FORM.name), {
      form: PRODUCT_ENQUIRY_FORM,
      pagePath: "/store/",
    });

    await Deno.writeTextFile(
      products,
      JSON.stringify({ indexPath: null, currency: null, categories: [], items: [item] }),
    );
    assertEquals(
      loadSiteForms(`${dir}/pages`, products).get(PRODUCT_ENQUIRY_FORM.name)?.pagePath,
      "/shop/",
    );

    for (
      const empty of [
        "",
        "{}",
        "{",
        JSON.stringify({ indexPath: "/shop/", categories: [], items: [] }),
      ]
    ) {
      await Deno.writeTextFile(products, empty);
      assertEquals(
        loadSiteForms(`${dir}/pages`, products).size,
        0,
        `no shop for ${JSON.stringify(empty)}`,
      );
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("site forms: a product enquiry needs the product, a name and an email", () => {
  const ok = validateSubmission(PRODUCT_ENQUIRY_FORM, {
    product: "Silver band ring",
    name: "Ada",
    email: "ada@example.com",
    message: "Size 7?",
  });
  assertEquals(ok, {
    ok: true,
    values: {
      product: "Silver band ring",
      name: "Ada",
      email: "ada@example.com",
      message: "Size 7?",
    },
  });
  const bad = validateSubmission(PRODUCT_ENQUIRY_FORM, { name: "Ada", email: "nope" });
  assertEquals(bad.ok, false);
  if (!bad.ok) assertEquals(Object.keys(bad.errors).sort(), ["email", "product"]);
});

Deno.test("site forms: an unknown form is a 404", async () => {
  const res = await app(formNamed("contact")).request("/api/site-forms/nope", {
    method: "POST",
    body: formBody(GOOD),
  });
  assertEquals(res.status, 404);
  assertEquals((await res.json()).code, "NOT_FOUND");
});

dbTest("site forms: a JSON post stores the submission and queues the owner email", async () => {
  const name = uniqueName();
  try {
    const res = await app(formNamed(name), {
      recipients: ["owner@example.com", "partner@example.com"],
    }).request(
      `/api/site-forms/${name}`,
      {
        method: "POST",
        headers: { "content-type": "application/json", "user-agent": "test-agent" },
        body: JSON.stringify(GOOD),
      },
    );
    assertEquals(res.status, 201);
    assertEquals(await res.json(), { data: { status: "sent" } });
    const rows = await rowsFor(name);
    assertEquals(rows.length, 1);
    assertEquals(rows[0].pagePath, "/contact/");
    assertEquals(rows[0].userAgent, "test-agent");
    assertEquals(rows[0].data.topics, ["Gutters", "Skylights"]);
    assertEquals(rows[0].data.consent, true);
    const mail = await db.selectFrom("email_outbox").selectAll()
      .where("idempotencyKey", "like", `site-form:${rows[0].id}:%`).orderBy("toEmail").execute();
    assertEquals(mail.map((m) => m.toEmail), ["owner@example.com", "partner@example.com"]);
    assertEquals(mail[0].replyTo, "pat@example.com", "the visitor's email is the Reply-To");
    assertEquals(mail[0].source, "site-form-submission");
    assert(mail[0].subject.includes(name));
    assert(mail[0].textBody.includes("Your name: Pat Visitor"));
    assert(mail[0].textBody.includes("Topics: Gutters, Skylights"));
    assert(mail[0].htmlBody?.includes("My roof leaks over the kitchen."));
  } finally {
    await cleanup(name);
  }
});

dbTest("site forms: an HTML form post redirects back to the page with the status", async () => {
  const name = uniqueName();
  try {
    const sent = await app(formNamed(name)).request(`/api/site-forms/${name}`, {
      method: "POST",
      body: formBody({ ...GOOD, _page: "/about-us/" }),
    });
    assertEquals(sent.status, 303);
    assertEquals(sent.headers.get("location"), `/about-us/#form-${name}-sent`);
    assertEquals(
      (await rowsFor(name))[0].data.topics,
      ["Gutters", "Skylights"],
      "repeated keys become a list",
    );

    const invalid = await app(formNamed(name)).request(`/api/site-forms/${name}`, {
      method: "POST",
      body: formBody({ ...GOOD, email: "nope", _page: "//evil.example.com/" }),
    });
    assertEquals(invalid.status, 303);
    assertEquals(
      invalid.headers.get("location"),
      `/contact/#form-${name}-invalid`,
      "an off-site _page falls back to the form's page",
    );
    assertEquals((await rowsFor(name)).length, 1);
  } finally {
    await cleanup(name);
  }
});

dbTest(
  "site forms: invalid JSON gets 400 with a message per field and stores nothing",
  async () => {
    const name = uniqueName();
    try {
      const res = await app(formNamed(name)).request(`/api/site-forms/${name}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...GOOD, email: "nope", service: "Painting" }),
      });
      assertEquals(res.status, 400);
      const body = await res.json();
      assertEquals(body.code, "VALIDATION_ERROR");
      assertEquals(Object.keys(body.fields).sort(), ["email", "service"]);
      assertEquals((await rowsFor(name)).length, 0);
      const garbage = await app(formNamed(name)).request(`/api/site-forms/${name}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "[1,2",
      });
      assertEquals(garbage.status, 400);
    } finally {
      await cleanup(name);
    }
  },
);

dbTest("site forms: a honeypot hit looks like success but stores and sends nothing", async () => {
  const name = uniqueName();
  try {
    const res = await app(formNamed(name)).request(`/api/site-forms/${name}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...GOOD, _website: "http://spam.example.com" }),
    });
    assertEquals(res.status, 201);
    assertEquals((await rowsFor(name)).length, 0);
  } finally {
    await cleanup(name);
  }
});

dbTest(
  "site forms: over the rate limit is 429 (JSON) or #limited (form) and stores nothing",
  async () => {
    const name = uniqueName();
    try {
      const json = await app(formNamed(name), { limited: true }).request(
        `/api/site-forms/${name}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(GOOD),
        },
      );
      assertEquals(json.status, 429);
      assertEquals((await json.json()).code, "RATE_LIMITED");
      const form = await app(formNamed(name), { limited: true }).request(
        `/api/site-forms/${name}`,
        {
          method: "POST",
          body: formBody(GOOD),
        },
      );
      assertEquals(form.status, 303);
      assertEquals(form.headers.get("location"), `/contact/#form-${name}-limited`);
      assertEquals((await rowsFor(name)).length, 0);
    } finally {
      await cleanup(name);
    }
  },
);

dbTest(
  "site forms: with no owner address the submission is stored and no email is queued",
  async () => {
    const name = uniqueName();
    try {
      const res = await app(formNamed(name), { recipients: [] }).request(
        `/api/site-forms/${name}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(GOOD),
        },
      );
      assertEquals(res.status, 201);
      const rows = await rowsFor(name);
      assertEquals(rows.length, 1);
      const mail = await db.selectFrom("email_outbox").select("id")
        .where("idempotencyKey", "like", `site-form:${rows[0].id}:%`).execute();
      assertEquals(mail.length, 0);
    } finally {
      await cleanup(name);
    }
  },
);

Deno.test("site forms: a body over 32 KB is refused", async () => {
  const res = await app(formNamed("contact")).request("/api/site-forms/contact", {
    method: "POST",
    headers: { "content-type": "application/json", "content-length": String(40 * 1024) },
    body: JSON.stringify({ ...GOOD, message: "x".repeat(40 * 1024) }),
  });
  assertEquals(res.status, 413);
});

Deno.test("site forms: LEAD_NOTIFICATION_EMAIL names the owner addresses", async () => {
  __setEnvForTest(
    "LEAD_NOTIFICATION_EMAIL",
    "owner@example.com, not-an-address , partner@example.com",
  );
  try {
    assertEquals(await siteFormRecipients(), ["owner@example.com", "partner@example.com"]);
  } finally {
    __deleteEnvForTest("LEAD_NOTIFICATION_EMAIL");
  }
});

Deno.test("app.ts mounts the site forms route", async () => {
  const src = await Deno.readTextFile(new URL("../../../app.ts", import.meta.url));
  assert(src.includes('app.route("/api/site-forms", siteFormsRoutes)'));
});

// ── Attribution (landing campaigns) ──

Deno.test("site forms: attribution reads the UTM values and the campaign from the Referer", () => {
  const ref =
    "https://acme.example.com/contact/?utm_source=facebook&utm_content=spring-storm&fbclid=xyz&email=a@b.co";
  assertEquals(siteFormAttribution(ref, "/contact/", CAMPAIGNS), {
    attribution: {
      utmSource: "facebook",
      utmContent: "spring-storm",
      fbclid: "xyz",
      landingCampaign: "roof-storm",
      landingCampaignName: "Storm damage, Meta ads",
    },
    backQuery: "?utm_source=facebook&utm_content=spring-storm&fbclid=xyz&email=a@b.co",
  });
  assertEquals(
    siteFormAttribution(ref, "/other/", CAMPAIGNS).backQuery,
    "",
    "the query only follows its own page",
  );
  assertEquals(siteFormAttribution(undefined, "/contact/", CAMPAIGNS), {
    attribution: {},
    backQuery: "",
  });
  assertEquals(siteFormAttribution("not a url", "/contact/", CAMPAIGNS), {
    attribution: {},
    backQuery: "",
  });
  assertEquals(siteFormAttribution("https://acme.example.com/contact/", "/contact/", CAMPAIGNS), {
    attribution: {},
    backQuery: "",
  });
});

dbTest(
  "site forms: a lead from a campaign stores its attribution, names it in the email, and returns to the same variant",
  async () => {
    const name = uniqueName();
    try {
      const res = await app(formNamed(name)).request(`/api/site-forms/${name}`, {
        method: "POST",
        headers: {
          referer: "https://acme.example.com/contact/?utm_source=facebook&utm_content=storm-video",
        },
        body: formBody({ ...GOOD, _page: "/contact/" }),
      });
      assertEquals(res.status, 303);
      assertEquals(
        res.headers.get("location"),
        `/contact/?utm_source=facebook&utm_content=storm-video#form-${name}-sent`,
      );
      const rows = await rowsFor(name);
      assertEquals(rows[0].attribution, {
        utmSource: "facebook",
        utmContent: "storm-video",
        landingCampaign: "roof-storm",
        landingCampaignName: "Storm damage, Meta ads",
      });
      const mail = await db.selectFrom("email_outbox").selectAll()
        .where("idempotencyKey", "like", `site-form:${rows[0].id}:%`).executeTakeFirstOrThrow();
      assert(mail.textBody.includes("Where they came from:"));
      assert(mail.textBody.includes("Landing page version: Storm damage, Meta ads"));
      assert(mail.textBody.includes("Source: facebook"));
      assert(mail.htmlBody?.includes("Where they came from"));
    } finally {
      await cleanup(name);
    }
  },
);

dbTest(
  "site forms: a lead with no URL values stores NULL attribution and no source lines",
  async () => {
    const name = uniqueName();
    try {
      await app(formNamed(name)).request(`/api/site-forms/${name}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          referer: "https://acme.example.com/contact/",
        },
        body: JSON.stringify(GOOD),
      });
      const rows = await rowsFor(name);
      assertEquals(rows[0].attribution, null);
      const mail = await db.selectFrom("email_outbox").selectAll()
        .where("idempotencyKey", "like", `site-form:${rows[0].id}:%`).executeTakeFirstOrThrow();
      assert(!mail.textBody.includes("Where they came from"));
    } finally {
      await cleanup(name);
    }
  },
);
