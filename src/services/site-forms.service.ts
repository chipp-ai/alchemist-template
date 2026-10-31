/**
 * Site forms: the form sections on the landing site
 * (landing/src/components/sections/Form.astro).
 *
 * The forms are defined in the landing content, one JSON file per page in
 * landing/src/content/pages/. The server reads those files once, so the
 * fields it accepts are exactly the fields the page shows. A submission is
 * validated against its form, stored as one row in site_form_submissions
 * (the fields as a JSONB object), and an email to the site owner is queued
 * in the same transaction through the outbox (src/services/email-outbox.service.ts).
 *
 * The owner is LEAD_NOTIFICATION_EMAIL when it is set (the same address the
 * lead form uses; comma-separated for more than one), else the first owner
 * account of this app. With neither, the submission is stored and no email
 * is sent.
 */

import { log } from "@/lib/logger.ts";
import { getEnv } from "@/lib/env.ts";
import { db } from "@/db/client.ts";
import type { SiteFormSubmission } from "@/db/schema.ts";
import { enqueueEmail } from "@/services/email-outbox.service.ts";
import { escapeHtml, registerEmailKind, renderEmailKind } from "@/services/email.ts";
import {
  type ComposedPage,
  type FormField,
  formsOf,
  normalizePagePath,
  pageProblems,
  type SiteForm,
} from "../../landing/src/lib/composed.ts";

/** Where the landing content pages live, relative to the repo root (the server's cwd). */
export const LANDING_PAGES_DIR = "./landing/src/content/pages";

export interface SiteFormEntry {
  form: SiteForm;
  pagePath: string;
}

/**
 * Read every form section from the landing content pages. A page file that
 * does not parse or fails validation is skipped with a warning: the landing
 * build fails on it anyway, so it is never on the live site.
 */
export function loadSiteForms(dir: string = LANDING_PAGES_DIR): Map<string, SiteFormEntry> {
  const pages: ComposedPage[] = [];
  const walk = (rel: string) => {
    let entries: Iterable<Deno.DirEntry>;
    try {
      entries = Deno.readDirSync(`${dir}${rel}`);
    } catch {
      return;
    }
    for (const e of entries) {
      const path = `${rel}/${e.name}`;
      if (e.isDirectory) walk(path);
      else if (e.isFile && e.name.endsWith(".json")) {
        try {
          const data = JSON.parse(Deno.readTextFileSync(`${dir}${path}`));
          const problems = pageProblems(data, path);
          if (problems.length > 0) {
            log.warn("site forms: skipped an invalid landing page file", {
              source: "site-forms",
              feature: "load",
              file: path,
              problem: problems[0],
            });
            continue;
          }
          pages.push(data as ComposedPage);
        } catch (err) {
          log.warn("site forms: a landing page file does not parse", {
            source: "site-forms",
            feature: "load",
            file: path,
          }, err instanceof Error ? err : new Error(String(err)));
        }
      }
    }
  };
  walk("");
  const forms = new Map<string, SiteFormEntry>();
  for (const { form, pagePath } of formsOf(pages)) {
    if (!forms.has(form.name)) forms.set(form.name, { form, pagePath: normalizePagePath(pagePath) });
  }
  return forms;
}

// ── Validation ──

export type SubmittedValue = string | boolean | string[];

/** Raw submitted values: a form post can repeat a key (checkboxes). */
export type RawSubmission = Record<string, string | string[] | undefined>;

const MAX_LENGTH: Partial<Record<FormField["type"], number>> = { textarea: 5000 };
const DEFAULT_MAX = 500;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TEL_RE = /^[0-9+().\-\s]{3,40}$/;
const NUMBER_RE = /^-?\d{1,15}([.,]\d{1,6})?$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function first(v: string | string[] | undefined): string {
  return (Array.isArray(v) ? v[0] : v ?? "").trim();
}

function list(v: string | string[] | undefined): string[] {
  return (Array.isArray(v) ? v : v === undefined ? [] : [v]).map((x) => x.trim()).filter(Boolean);
}

function validDate(s: string): boolean {
  if (!DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/**
 * Check a submission against its form. Returns the clean values (only the
 * form's own fields, trimmed, typed) or a message per bad field.
 */
export function validateSubmission(
  form: SiteForm,
  raw: RawSubmission,
): { ok: true; values: Record<string, SubmittedValue> } | { ok: false; errors: Record<string, string> } {
  const values: Record<string, SubmittedValue> = {};
  const errors: Record<string, string> = {};
  for (const f of form.fields) {
    const input = raw[f.name];
    if (f.type === "checkboxes") {
      const picked = list(input);
      const options = f.options ?? [];
      if (picked.some((p) => !options.includes(p))) errors[f.name] = "Pick from the listed options.";
      else if (f.required && picked.length === 0) errors[f.name] = "Pick at least one.";
      else if (picked.length > 0) values[f.name] = [...new Set(picked)];
      continue;
    }
    if (f.type === "checkbox") {
      const on = ["yes", "on", "true", "1"].includes(first(input).toLowerCase());
      if (f.required && !on) errors[f.name] = "This box must be checked.";
      else values[f.name] = on;
      continue;
    }
    const value = f.type === "hidden" ? f.value ?? "" : first(input);
    if (!value) {
      if (f.required) errors[f.name] = `${f.label} is required.`;
      continue;
    }
    const max = MAX_LENGTH[f.type] ?? DEFAULT_MAX;
    if (value.length > max) {
      errors[f.name] = `Keep ${f.label} to ${max} characters or fewer.`;
      continue;
    }
    let problem: string | null = null;
    switch (f.type) {
      case "email":
        if (!EMAIL_RE.test(value)) problem = "Enter a valid email address.";
        break;
      case "tel":
        if (!TEL_RE.test(value)) problem = "Enter a valid phone number.";
        break;
      case "url":
        try {
          const u = new URL(value);
          if (u.protocol !== "http:" && u.protocol !== "https:") problem = "Enter a web address that starts with http.";
        } catch {
          problem = "Enter a valid web address.";
        }
        break;
      case "number":
        if (!NUMBER_RE.test(value)) problem = "Enter a number.";
        break;
      case "date":
        if (!validDate(value)) problem = "Enter a date.";
        break;
      case "select":
      case "radio":
        if (!(f.options ?? []).includes(value)) problem = "Pick from the listed options.";
        break;
    }
    if (problem) errors[f.name] = problem;
    else values[f.name] = value;
  }
  return Object.keys(errors).length > 0 ? { ok: false, errors } : { ok: true, values };
}

// ── Owner email ──

export const SITE_FORM_EMAIL_KIND = "site-form-submission";

interface SiteFormEmailData {
  formName: string;
  pagePath: string;
  fields: { label: string; value: string }[];
}

registerEmailKind<SiteFormEmailData>({
  kind: SITE_FORM_EMAIL_KIND,
  description: "A visitor sent a form on the public website.",
  subject: (d) => `New "${d.formName}" form from your website`,
  text: (d) =>
    [`A visitor sent the "${d.formName}" form on ${d.pagePath}.`, "", ...d.fields.map((f) => `${f.label}: ${f.value}`)]
      .join("\n"),
  body: (d) => ({
    previewText: `New "${d.formName}" form from your website`,
    html: `<p>A visitor sent the <strong>${escapeHtml(d.formName)}</strong> form on ${escapeHtml(d.pagePath)}.</p>` +
      `<table role="presentation" cellpadding="6" cellspacing="0">${
        d.fields.map((f) =>
          `<tr><td valign="top"><strong>${escapeHtml(f.label)}</strong></td><td style="white-space:pre-wrap">${
            escapeHtml(f.value)
          }</td></tr>`
        ).join("")
      }</table>`,
  }),
  sample: () => ({
    formName: "contact",
    pagePath: "/contact/",
    fields: [
      { label: "Name", value: "Sample Visitor" },
      { label: "Email", value: "visitor@example.com" },
      { label: "Message", value: "Hello, I would like a quote." },
    ],
  }),
});

/** Who gets the email: LEAD_NOTIFICATION_EMAIL, else the first owner account. */
export async function siteFormRecipients(): Promise<string[]> {
  const configured = (getEnv("LEAD_NOTIFICATION_EMAIL") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => EMAIL_RE.test(s));
  if (configured.length > 0) return configured;
  const owner = await db
    .selectFrom("users")
    .select("email")
    .where("role", "=", "owner")
    .orderBy("createdAt", "asc")
    .limit(1)
    .executeTakeFirst();
  return owner?.email ? [owner.email] : [];
}

function display(v: SubmittedValue): string {
  if (Array.isArray(v)) return v.join(", ");
  if (typeof v === "boolean") return v ? "Yes" : "No";
  return v;
}

/**
 * Store one valid submission and queue the owner email, atomically. A
 * visitor's email field becomes the Reply-To, so the owner can answer
 * from their inbox.
 */
export async function createSiteFormSubmission(input: {
  entry: SiteFormEntry;
  values: Record<string, SubmittedValue>;
  userAgent?: string | null;
  recipients: string[];
}): Promise<SiteFormSubmission> {
  const { form, pagePath } = input.entry;
  const fields = form.fields
    .filter((f) => input.values[f.name] !== undefined && f.type !== "hidden")
    .map((f) => ({ label: f.label, value: display(input.values[f.name]) }));
  const replyTo = form.fields
    .filter((f) => f.type === "email")
    .map((f) => input.values[f.name])
    .find((v): v is string => typeof v === "string" && EMAIL_RE.test(v));

  const row = await db.transaction().execute(async (trx) => {
    const saved = await trx
      .insertInto("site_form_submissions")
      .values({
        formName: form.name,
        pagePath,
        data: input.values,
        userAgent: input.userAgent ? input.userAgent.slice(0, 500) : null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    if (input.recipients.length > 0) {
      const rendered = renderEmailKind<SiteFormEmailData>(SITE_FORM_EMAIL_KIND, { formName: form.name, pagePath, fields });
      for (const to of input.recipients) {
        await enqueueEmail({
          to,
          subject: rendered.subject,
          text: rendered.text,
          html: rendered.html,
          replyTo,
          idempotencyKey: `site-form:${saved.id}:${to.toLowerCase()}`,
          source: SITE_FORM_EMAIL_KIND,
        }, trx);
      }
    }
    return saved;
  });

  if (input.recipients.length === 0) {
    log.info("site form stored; no owner address, so no email was queued", {
      source: "site-forms",
      feature: "notify",
      formName: form.name,
      submissionId: row.id,
    });
  }
  return row;
}
