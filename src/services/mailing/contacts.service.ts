/**
 * Mailing-list contacts: who a campaign can go to, and how each one got on
 * the list.
 *
 * Three doors, and the door decides how the first campaign treats them:
 *
 *   signup   `addSignupContact()` from the app's own subscribe form or a
 *            "send me news" checkbox. Organic: no warm-up.
 *   import   the `email_contacts` spreadsheet import (registered here).
 *            The importer must say where the list came from and attest the
 *            people opted in. Cold until their first campaign, which goes
 *            out in the warm-up ramp.
 *   manual   `addManualContact()`, an admin typing an address in. Needs the
 *            same attestation as an import, and is cold too.
 *
 * Every door runs the same hygiene (hygiene.ts) and dedupes on
 * (organization, lowercased email). None of them can resurrect an address
 * that unsubscribed, bounced or complained: re-importing an old export is
 * the classic way a list mails people who already said no.
 */

import { sql } from "kysely";
import { db } from "@/db/client.ts";
import type { EmailContactOrigin, EmailContactRow, EmailContactStatus } from "@/db/schema.ts";
import { getEnv } from "@/lib/env.ts";
import { BadRequestError, ConflictError } from "@/utils/errors.ts";
import {
  findImportDefinition,
  type ImportAttestation,
  type ImportAttestationSpec,
  type ImportDefinition,
  type ImportRowProblem,
  registerImportDefinition,
  splitFullName,
  validateImportAttestation,
} from "@/services/import/definitions.ts";
import {
  checkAddress,
  checkDomainsHaveMx,
  MX_CHECK_ENV,
  normalizeAddress,
} from "@/services/mailing/hygiene.ts";

export const CONTACTS_IMPORT_NAME = "email_contacts";

/** The answers to "where did this list come from?". */
export const CONTACT_LIST_SOURCES = [
  { value: "app_signup", label: "People who signed up in this app", collectedInApp: true },
  {
    value: "previous_platform",
    label: "Exported from another platform (Kajabi, Mailchimp, ConvertKit, ...)",
    collectedInApp: false,
  },
  { value: "website_form", label: "A signup form on my own website", collectedInApp: false },
  { value: "event", label: "Collected in person or at an event", collectedInApp: false },
  { value: "customers", label: "My own customers who agreed to email", collectedInApp: false },
  { value: "other", label: "Somewhere else", collectedInApp: false },
] as const;

export const CONTACT_IMPORT_ATTESTATION: ImportAttestationSpec = {
  question: "Where did this list come from?",
  sources: CONTACT_LIST_SOURCES,
  statement:
    "Everyone on this list agreed to receive email from me, and I am not importing purchased, " +
    "rented or scraped addresses.",
  externalWarning:
    "This list was not collected through this app. People who signed up somewhere else often " +
    "do not recognise a new sender, and old exports are full of addresses that no longer work. " +
    "Both turn into spam complaints and bounces, which can stop all of this app's email, " +
    "sign-in codes included. Import only people who asked for your email, and expect the " +
    "first campaign to them to go out slowly in small batches.",
};

// ── Hygiene for a batch of addresses ─────────────────────────────────────

function mxCheckEnabled(): boolean {
  try {
    const v = (getEnv(MX_CHECK_ENV) ?? "").toLowerCase();
    return v === "1" || v === "true";
  } catch {
    return false;
  }
}

/**
 * Screen addresses for one workspace. One entry per input, `null` = fine.
 * Refuses invalid, typo, role/test and reserved addresses, addresses
 * already suppressed for this workspace, and (when MAILING_MX_CHECK=1)
 * domains with no mail server.
 */
export async function screenAddresses(
  organizationId: string,
  emails: readonly string[],
): Promise<Array<string | null>> {
  const results: Array<string | null> = emails.map((e) => {
    const check = checkAddress(e);
    return check.ok ? null : `Email ${check.reason}`;
  });

  const okEmails = emails.map(normalizeAddress).filter((_, i) => results[i] === null);
  if (okEmails.length === 0) return results;

  const suppressed = new Map<string, string>();
  for (let i = 0; i < okEmails.length; i += 1000) {
    const chunk = okEmails.slice(i, i + 1000);
    const rows = await db
      .selectFrom("email_suppressions")
      .select(["email", "reason"])
      .where("email", "in", chunk)
      .where((eb) =>
        eb.or([eb("organizationId", "is", null), eb("organizationId", "=", organizationId)])
      )
      .execute();
    for (const r of rows) suppressed.set(r.email, r.reason);
  }

  const noMx = mxCheckEnabled()
    ? await checkDomainsHaveMx(okEmails.map((e) => e.slice(e.lastIndexOf("@") + 1)))
    : new Set<string>();

  emails.forEach((raw, i) => {
    if (results[i] !== null) return;
    const email = normalizeAddress(raw);
    const reason = suppressed.get(email);
    if (reason) {
      results[i] = reason === "unsubscribed"
        ? "Email unsubscribed from this workspace's mail. It is not added back."
        : `Email is suppressed (${reason.replace("_", " ")}). It is not mailed again.`;
      return;
    }
    const domain = email.slice(email.lastIndexOf("@") + 1);
    if (noMx.has(domain)) results[i] = `Email domain ${domain} has no mail server.`;
  });
  return results;
}

// ── Writes ───────────────────────────────────────────────────────────────

export interface ContactInput {
  organizationId: string;
  email: string;
  firstName?: string | null;
  lastName?: string | null;
}

function cleanName(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim().replace(/\s+/g, " ");
  return t ? t.slice(0, 200) : null;
}

async function assertAddressUsable(organizationId: string, email: string): Promise<string> {
  const [problem] = await screenAddresses(organizationId, [email]);
  if (problem) throw new BadRequestError(problem);
  return normalizeAddress(email);
}

/**
 * Someone subscribed through this app. Idempotent: an existing contact
 * keeps its row (and its status; a person who unsubscribed and signs up
 * again IS opting back in, so that one case flips them back).
 */
export async function addSignupContact(input: ContactInput): Promise<EmailContactRow> {
  const email = await assertAddressUsableForSignup(input.email);
  const row = await db
    .insertInto("email_contacts")
    .values({
      organizationId: input.organizationId,
      email,
      firstName: cleanName(input.firstName),
      lastName: cleanName(input.lastName),
      origin: "signup",
      consentSource: "app_signup",
      consentCollectedInApp: true,
      consentAttestedAt: new Date(),
    })
    .onConflict((oc) =>
      oc.columns(["organizationId", "email"]).doUpdateSet({
        // An explicit new signup is consent again; a bounce or complaint is not undone.
        status:
          sql`CASE WHEN email_contacts.status = 'unsubscribed' THEN 'subscribed' ELSE email_contacts.status END`,
        unsubscribedAt:
          sql`CASE WHEN email_contacts.status = 'unsubscribed' THEN NULL ELSE email_contacts.unsubscribed_at END`,
      })
    )
    .returningAll()
    .executeTakeFirstOrThrow();

  // The person asked again, so a workspace-scoped unsubscribe row goes.
  await db
    .deleteFrom("email_suppressions")
    .where("email", "=", email)
    .where("organizationId", "=", input.organizationId)
    .where("reason", "=", "unsubscribed")
    .execute();
  return row;
}

/** Signup ignores a workspace unsubscribe (the person is opting back in). */
async function assertAddressUsableForSignup(raw: string): Promise<string> {
  const check = checkAddress(raw);
  if (!check.ok) throw new BadRequestError(`Email ${check.reason}`);
  const appWide = await db
    .selectFrom("email_suppressions")
    .select(["reason"])
    .where("email", "=", check.email)
    .where("organizationId", "is", null)
    .executeTakeFirst();
  if (appWide && appWide.reason !== "unsubscribed") {
    throw new BadRequestError(
      `Email is suppressed (${appWide.reason.replace("_", " ")}). It is not mailed again.`,
    );
  }
  return check.email;
}

/**
 * An admin adds one address by hand. Same attestation as an import, and
 * the contact is cold until its first campaign.
 */
export async function addManualContact(
  input: ContactInput & { userId: string | null; attestation: unknown },
): Promise<EmailContactRow> {
  const definition = findImportDefinition(CONTACTS_IMPORT_NAME) ?? contactsImportDefinition;
  const attestation = validateImportAttestation(definition, input.attestation, {
    userId: input.userId,
  });
  const email = await assertAddressUsable(input.organizationId, input.email);
  const existing = await db
    .selectFrom("email_contacts")
    .select(["id"])
    .where("organizationId", "=", input.organizationId)
    .where("email", "=", email)
    .executeTakeFirst();
  if (existing) throw new ConflictError(`${email} is already on this workspace's list.`);
  return await db
    .insertInto("email_contacts")
    .values({
      organizationId: input.organizationId,
      email,
      firstName: cleanName(input.firstName),
      lastName: cleanName(input.lastName),
      origin: "manual",
      ...consentColumns(attestation),
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

function consentColumns(a: ImportAttestation) {
  return {
    consentSource: a.listSource,
    consentSourceDetail: a.listSourceDetail,
    consentCollectedInApp: a.collectedInApp,
    consentAttestedAt: new Date(a.attestedAt),
    consentAttestedBy: a.attestedBy,
  };
}

// ── Reads ────────────────────────────────────────────────────────────────

export interface ListContactsOptions {
  organizationId: string;
  status?: EmailContactStatus;
  origin?: EmailContactOrigin;
  limit?: number;
  offset?: number;
}

export async function listContacts(opts: ListContactsOptions): Promise<EmailContactRow[]> {
  let q = db
    .selectFrom("email_contacts")
    .selectAll()
    .where("organizationId", "=", opts.organizationId)
    .orderBy("createdAt", "desc")
    .limit(Math.min(Math.max(opts.limit ?? 100, 1), 500))
    .offset(Math.max(opts.offset ?? 0, 0));
  if (opts.status) q = q.where("status", "=", opts.status);
  if (opts.origin) q = q.where("origin", "=", opts.origin);
  return await q.execute();
}

export async function contactCounts(organizationId: string) {
  const rows = await db
    .selectFrom("email_contacts")
    .select((eb) => ["status", "origin", eb.fn.countAll<string>().as("n")])
    .where("organizationId", "=", organizationId)
    .groupBy(["status", "origin"])
    .execute();
  const counts = { subscribed: 0, unsubscribed: 0, suppressed: 0, cold: 0, total: 0 };
  for (const r of rows) {
    const n = Number(r.n);
    counts[r.status] += n;
    counts.total += n;
  }
  const cold = await db
    .selectFrom("email_contacts")
    .select((eb) => eb.fn.countAll<string>().as("n"))
    .where("organizationId", "=", organizationId)
    .where("status", "=", "subscribed")
    .where("origin", "!=", "signup")
    .where("firstSentAt", "is", null)
    .executeTakeFirst();
  counts.cold = Number(cold?.n ?? 0);
  return counts;
}

// ── The import definition ────────────────────────────────────────────────

export const contactsImportDefinition: ImportDefinition = {
  name: CONTACTS_IMPORT_NAME,
  label: "Mailing list contacts",
  description:
    "Email subscribers for newsletters and campaigns. You will be asked where the list came " +
    "from and to confirm everyone opted in. Typos, test addresses and people who already " +
    "unsubscribed or bounced are skipped. Re-importing updates names; it never re-subscribes " +
    "anyone.",
  // Mailing people is an admin decision, same as inviting them.
  capability: "email.broadcast",
  attestation: CONTACT_IMPORT_ATTESTATION,
  fields: [
    {
      key: "email",
      label: "Email",
      kind: "email",
      required: true,
      aliases: ["email address", "e-mail", "subscriber", "subscriber email", "contact email"],
    },
    {
      key: "fullName",
      label: "Full name",
      kind: "text",
      inputOnly: true,
      aliases: ["name", "subscriber name", "contact name"],
      maxLength: 200,
    },
    {
      key: "firstName",
      label: "First name",
      kind: "text",
      aliases: ["first", "given name", "fname"],
      maxLength: 200,
    },
    {
      key: "lastName",
      label: "Last name",
      kind: "text",
      aliases: ["last", "surname", "family name", "lname"],
      maxLength: 200,
    },
  ],
  derive: [splitFullName({ from: "fullName", first: "firstName", last: "lastName" })],
  // Dedupe on the address, inside the file and against the list.
  matchBy: [["email"]],

  async screenRows({ organizationId, rows }): Promise<Array<ImportRowProblem | null>> {
    const problems = await screenAddresses(organizationId, rows.map((r) => String(r.email ?? "")));
    return problems.map((message) => (message ? { field: "email", message } : null));
  },

  async loadExisting({ organizationId, rows }) {
    const emails = [...new Set(rows.map((r) => String(r.email ?? "")).filter(Boolean))];
    if (emails.length === 0) return [];
    const found: Array<{ id: string; email: string }> = [];
    for (let i = 0; i < emails.length; i += 1000) {
      found.push(
        ...await db
          .selectFrom("email_contacts")
          .select(["id", "email"])
          // Org-scoped in the WHERE clause (CWE-639).
          .where("organizationId", "=", organizationId)
          .where("email", "in", emails.slice(i, i + 1000))
          .execute(),
      );
    }
    return found.map((r) => ({ id: r.id, values: { email: r.email } }));
  },

  async upsertRow({ trx, organizationId, values, existingId, attestation, importSessionId }) {
    if (!attestation) throw new Error("Contacts import committed without an attestation.");
    const firstName = cleanName(values.firstName);
    const lastName = cleanName(values.lastName);
    if (existingId) {
      // Names only. Status, origin and consent stay as they were: an
      // import never re-subscribes or "re-consents" an existing contact.
      const row = await trx
        .updateTable("email_contacts")
        .set({
          ...(firstName ? { firstName } : {}),
          ...(lastName ? { lastName } : {}),
        })
        .where("id", "=", existingId)
        .where("organizationId", "=", organizationId)
        .returning(["id"])
        .executeTakeFirstOrThrow();
      return { id: row.id };
    }
    const row = await trx
      .insertInto("email_contacts")
      .values({
        organizationId,
        email: normalizeAddress(String(values.email)),
        firstName,
        lastName,
        origin: "import",
        importSessionId,
        ...consentColumns(attestation),
      })
      .returning(["id"])
      .executeTakeFirstOrThrow();
    return { id: row.id };
  },

  sampleCsv() {
    return "Email,First name,Last name\nada@yourbrand.com,Ada,Lovelace\n";
  },
};

/** Register the contacts import. Idempotent; call from main.ts. */
export function registerContactsImport(): void {
  if (!findImportDefinition(CONTACTS_IMPORT_NAME)) {
    registerImportDefinition(contactsImportDefinition);
  }
}
