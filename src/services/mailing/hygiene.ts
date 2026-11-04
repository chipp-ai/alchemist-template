/**
 * List hygiene: which addresses on a mailing list must never be mailed.
 *
 * Runs twice: at import (a bad row is skipped with a reason, in the
 * preview and in the result) and again when a campaign starts (a contact
 * that slipped in another way is skipped on that campaign, with a reason).
 *
 * Three classes of address are refused, and each one is a hard bounce or a
 * spam trap waiting to happen:
 *
 *   invalid       not an email address at all
 *   typo_domain   a well-known mailbox provider, misspelled
 *                 (gmail.co, hotmial.com, tahoo.com). The real person is at
 *                 the correctly spelled domain; the misspelled one bounces,
 *                 or worse, is a registered trap domain.
 *   role_or_test  probe@, test@, noreply@, postmaster@ and friends. Nobody
 *                 opted in from those, and some are monitored traps.
 *
 * Plus reserved domains (example.com, *.test), which can never receive mail.
 *
 * This is syntax, not deliverability: an address that passes can still
 * bounce. The optional MX check (`checkDomainsHaveMx`) is the cheap, bounded
 * next step, and provider bounce feedback (feedback.service.ts) is the real
 * one.
 *
 * Pure except for `checkDomainsHaveMx`, which does DNS through an injected
 * resolver.
 */

import { isReservedRecipientAddress } from "@/services/email-transport.ts";

export type AddressProblemCode = "invalid" | "typo_domain" | "role_or_test" | "reserved_domain";

export type AddressCheck =
  | { ok: true; email: string }
  | { ok: false; email: string; code: AddressProblemCode; reason: string; suggestion?: string };

/**
 * The same shape the import normalizer accepts, plus a dot-free local part
 * check: one `@`, no whitespace, a dot in the domain, a TLD of 2+ letters.
 */
const EMAIL_RE = /^[^\s@,;<>"]+@[^\s@,;<>".]+(\.[^\s@,;<>".]+)*\.[a-z]{2,}$/i;

/**
 * Misspelled provider domains, mapped to what the person meant. Only
 * domains that are not themselves a real mailbox provider: `yahoo.co.uk`
 * is real, so it is not here; `yahoo.co` alone is.
 */
export const TYPO_DOMAINS: Readonly<Record<string, string>> = Object.freeze({
  // gmail
  "gmail.co": "gmail.com",
  "gmail.cm": "gmail.com",
  "gmail.con": "gmail.com",
  "gmail.om": "gmail.com",
  "gmail.cmo": "gmail.com",
  "gmail.comm": "gmail.com",
  "gmail.c": "gmail.com",
  "gmial.com": "gmail.com",
  "gmai.com": "gmail.com",
  "gmal.com": "gmail.com",
  "gmaill.com": "gmail.com",
  "gamil.com": "gmail.com",
  "gnail.com": "gmail.com",
  "gmail.coom": "gmail.com",
  "googlemail.co": "googlemail.com",
  // yahoo
  "yaho.com": "yahoo.com",
  "yahooo.com": "yahoo.com",
  "tahoo.com": "yahoo.com",
  "yhoo.com": "yahoo.com",
  "yahoo.co": "yahoo.com",
  "yahoo.cm": "yahoo.com",
  "yahoo.con": "yahoo.com",
  "yaoo.com": "yahoo.com",
  // hotmail / outlook / live
  "hotmial.com": "hotmail.com",
  "hotmal.com": "hotmail.com",
  "hotmai.com": "hotmail.com",
  "hotmil.com": "hotmail.com",
  "hotmaill.com": "hotmail.com",
  "hotmail.co": "hotmail.com",
  "hotmail.cm": "hotmail.com",
  "hotmail.con": "hotmail.com",
  "homail.com": "hotmail.com",
  "outlok.com": "outlook.com",
  "outloo.com": "outlook.com",
  "outlook.co": "outlook.com",
  "outlook.con": "outlook.com",
  "otlook.com": "outlook.com",
  "live.co": "live.com",
  "live.con": "live.com",
  // icloud / aol / msn
  "iclod.com": "icloud.com",
  "icloud.co": "icloud.com",
  "icloud.con": "icloud.com",
  "icoud.com": "icloud.com",
  "aol.co": "aol.com",
  "aol.con": "aol.com",
  "msn.co": "msn.com",
});

/** A misspelled `.com` on any domain. */
const TYPO_TLDS: Readonly<Record<string, string>> = Object.freeze({
  con: "com",
  cmo: "com",
  ocm: "com",
  comm: "com",
  coom: "com",
  vom: "com",
  xom: "com",
});

/**
 * Local parts nobody opts in from: test and probe addresses, and the
 * system mailboxes. Deliberately NOT info@, sales@, hello@ or support@:
 * those are real inboxes a business contact may well have signed up with.
 */
export const ROLE_OR_TEST_LOCAL_PARTS: ReadonlySet<string> = new Set([
  "test",
  "testing",
  "tester",
  "probe",
  "noreply",
  "no-reply",
  "no_reply",
  "donotreply",
  "do-not-reply",
  "do_not_reply",
  "postmaster",
  "mailer-daemon",
  "mailerdaemon",
  "abuse",
  "bounce",
  "bounces",
  "spam",
  "devnull",
  "null",
  "nobody",
  "root",
  "hostmaster",
  "webmaster",
  "example",
  "fake",
  "asdf",
]);

/** `test1`, `probe42`, `test+anything`: the numbered and tagged variants. */
const NUMBERED_TEST_RE = /^(test|testing|probe|fake)[-_.]?\d*$/;

/** Lowercase and trim. The one dedupe key for an address. */
export function normalizeAddress(raw: string): string {
  return raw.trim().toLowerCase();
}

/** Check one address. Never throws. */
export function checkAddress(raw: string): AddressCheck {
  const email = normalizeAddress(raw ?? "");
  if (!email || !EMAIL_RE.test(email) || email.length > 320) {
    return { ok: false, email, code: "invalid", reason: "is not a valid email address." };
  }

  const at = email.lastIndexOf("@");
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);

  if (isReservedRecipientAddress(email)) {
    return {
      ok: false,
      email,
      code: "reserved_domain",
      reason: `uses ${domain}, a reserved domain that cannot receive mail.`,
    };
  }

  const typoFix = TYPO_DOMAINS[domain];
  if (typoFix) {
    return {
      ok: false,
      email,
      code: "typo_domain",
      reason: `looks like a typo for ${local}@${typoFix}. Fix it in the file and import again.`,
      suggestion: `${local}@${typoFix}`,
    };
  }
  const tld = domain.slice(domain.lastIndexOf(".") + 1);
  const tldFix = TYPO_TLDS[tld];
  if (tldFix) {
    const fixed = `${domain.slice(0, domain.length - tld.length)}${tldFix}`;
    return {
      ok: false,
      email,
      code: "typo_domain",
      reason: `looks like a typo for ${local}@${fixed}. Fix it in the file and import again.`,
      suggestion: `${local}@${fixed}`,
    };
  }

  // A plus tag does not change who the mailbox is: test+1@ is test@.
  const base = local.split("+")[0];
  if (ROLE_OR_TEST_LOCAL_PARTS.has(base) || NUMBERED_TEST_RE.test(base)) {
    return {
      ok: false,
      email,
      code: "role_or_test",
      reason:
        `is a test or system address (${base}@). Nobody opts in from one, so it is not mailed.`,
    };
  }

  return { ok: true, email };
}

// ── Optional MX check ────────────────────────────────────────────────────

/** Off unless the app turns it on. DNS from a pod is cheap but not free. */
export const MX_CHECK_ENV = "MAILING_MX_CHECK";
/** At most this many distinct domains are looked up per run. */
export const MX_CHECK_MAX_DOMAINS = 200;
/** Per lookup. A slow resolver must not hold up an import. */
export const MX_CHECK_TIMEOUT_MS = 1500;

export type MxResolver = (domain: string) => Promise<unknown[]>;

const denoMxResolver: MxResolver = (domain) => Deno.resolveDns(domain, "MX");

/**
 * Which of these domains have no mail server at all.
 *
 * Bounded three ways: distinct domains only, at most `maxDomains` of them
 * (the most common first, so the big providers are never the ones left
 * out), and a timeout on each lookup. A lookup that times out or errors for
 * any reason other than "no such record" counts as HAS MX: a flaky resolver
 * must never reject a real address.
 */
export async function checkDomainsHaveMx(
  domains: readonly string[],
  opts: { resolver?: MxResolver; maxDomains?: number; timeoutMs?: number } = {},
): Promise<Set<string>> {
  const resolver = opts.resolver ?? denoMxResolver;
  const maxDomains = opts.maxDomains ?? MX_CHECK_MAX_DOMAINS;
  const timeoutMs = opts.timeoutMs ?? MX_CHECK_TIMEOUT_MS;

  const counts = new Map<string, number>();
  for (const d of domains) counts.set(d, (counts.get(d) ?? 0) + 1);
  const picked = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, maxDomains).map(
    ([d]) => d,
  );

  const noMx = new Set<string>();
  await Promise.all(picked.map(async (domain) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const records = await Promise.race([
        resolver(domain),
        new Promise<"timeout">((resolve) => {
          timer = setTimeout(() => resolve("timeout"), timeoutMs);
        }),
      ]);
      if (Array.isArray(records) && records.length === 0) noMx.add(domain);
    } catch (err) {
      // Only a definite "this name has no such record / does not exist"
      // counts. Deno raises NotFound for NXDOMAIN and NODATA.
      if (err instanceof Deno.errors.NotFound) noMx.add(domain);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }));
  return noMx;
}
