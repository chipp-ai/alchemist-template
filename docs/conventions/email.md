# Email: inbound, outbound, the outbox

## Inbound email ingestion: built-in pipeline (do NOT rebuild this)

The template ships a dormant email-ingestion substrate: a purpose-built
address receives operational email (PDFs, spreadsheets, status updates) and
an LLM projects it into YOUR domain tables. **When a ticket says "ingest
emails", "process the ops inbox", "extract data from forwarded emails", or
"parse email attachments into the DB", wire it through this pipeline --
never build a new webhook receiver, IMAP poller, or extraction loop.**

The flow (all shipped, all dormant until configured):

```
Postmark inbound webhook -> POST /api/ingest/email?token=...   (fail-closed gate)
  -> capture.service.ts: dedup on Message-ID, attachments to R2,
     inbound_email + inbound_email_attachment rows, status='received'
  -> src/jobs/inbound-email-reaper.ts (60s loop, Redis job lock)
  -> extract.service.ts: LLM triage into { <your data> | human_message | unclear }
  -> YOUR extraction profile's applyData() -> your domain tables
  -> Inbound Email dashboard page (list/detail, signed attachment URLs)
```

**Your ONE integration point is an extraction profile**
(`src/services/inbound-email/profile.ts`):

```ts
registerInboundEmailExtractionProfile({
  dataKind: "invoice_data",              // discriminator for the domain variant
  dataSchema: z.object({ ... }),         // zod schema the LLM must fill
  extractionInstructions: "...",         // domain guidance appended to the triage prompt
  applyData: async ({ orgId, emailId, data }) => {
    // Idempotent, keyed on emailId (the reaper re-runs failed rows).
    // Recommended dedup key for downstream writes: `email:<emailId>|...`
    return { applied: n, summary: "..." };
  },
});
```

Register it once at boot (import from `main.ts` or a service init). Schema
rules (each prevents a real failure mode): LLM-optional fields are
`.nullish()` never `.optional()`; soft descriptive fields truncate (see
`softText` in extract.service.ts) rather than reject.

Invariants:

- **Never bypass the capture-first contract.** Extraction is a re-runnable
  projection over durably captured rows; if extraction logic changes, rows
  can be re-processed. Do not extract inline in the webhook handler.
- **`INGEST_EMAIL_TOKEN` unset = endpoint OFF** (fails closed). The
  platform mints the token and provisions the Postmark inbound address +
  MX record; do not hand-roll either.
- **Set `INGEST_ORG_ID`** in production: captured rows are attributed to
  that org and the dashboard is org-scoped (NULL-org rows are invisible).
- **Attachments live in R2 via `storage.service.ts` relative keys**; the
  key folder is a hash of the Message-ID (attacker-controlled input must
  not choose object paths). Disallowed/oversized attachments are recorded
  with an empty `r2_key` sentinel, never dropped.
- The extraction LLM call runs through the platform billing proxy
  (`LLM_CONFIG`); a 402 credits-exhausted response backs off for 3 days
  automatically.
- The dashboard renders untrusted email HTML ONLY inside `sandbox=""`
  iframes via `frameSrcdocForEmailHtml()` (CSP blocks remote loads). Keep
  it that way.

## Who delivers outbound mail

Chipp delivers sign-in mail for every hosted app, free. Everything else
needs the project's own email provider.

| Mail | Delivered by |
|---|---|
| Sign-in code, sign-in link, email verification, password reset, team invite link | Chipp's auth mail service (`src/services/platform-auth-mail.ts`), also when the project has its own provider |
| Everything else: notifications, reminders, digests, receipts, newsletters | The project's own provider, through `SMTP_HOST` / `SMTP_PORT` / `SMTP_USERNAME` / `SMTP_PASSWORD` / `EMAIL_FROM` |

How the auth lane works:

- A kind declares `authIntent` (the `otp`, `portal_link` and `invite`
  kinds do).
  `sendEmailKind` passes the intent to the transport, and the transport
  posts it to `POST $CHIPP_MAIL_URL/api/internal/project-mail/auth`. Chipp
  renders the message from its own fixed template, from the project's
  verified sending domain when it has one.
- An intent is `{ kind, to, code? | link?, expiresInMinutes? }`, where
  kind is `otp_code`, `magic_link`, `email_verification`,
  `password_reset` or `invitation` (link-only, like `magic_link`). One recipient. A code is 4 to 12 letters or digits. A
  link is https on one of the project's own domains. There is no subject or
  body field: Chipp refuses anything that is not a sign-in message, so a
  reminder can never be sent this way.
- Chipp limits it per recipient and per project, with a daily cap. A 429
  throws `PlatformAuthMailRefusedError` and never falls back to SMTP.
  "Unavailable" (no `CHIPP_MAIL_*` env, the route not deployed, a platform
  that does not know the kind yet, an outage) falls back to the project's SMTP, else the dev mailbox.
- A new sign-in kind (password reset, email verification) declares
  `authIntent` too. Never declare it on a kind that is not a sign-in
  message.

Non-auth mail needs a provider key the project owner supplies (SMTP, or an
API key for SendGrid, Resend, SES, Postmark or SMTP2GO behind an SMTP
endpoint). Ask for it with `request_credentials`; never ship non-auth mail
that depends on Chipp's shared sender. Until the key is set, non-auth mail
is captured to the dev mailbox in dev and is not delivered in production.

## Outbound email: register a kind, never rebuild the shell

Email is a configurable surface, not a place to hand-roll a message.
**When a ticket says "email them when X happens", "add an alert email", "let
admins send a test email", or "let people turn notifications off", wire it
through the pieces below.** Do not copy the branded HTML shell, do not add
a second `sendEmail` call site with its own markup, and do not invent a
per-app notification-preferences table.

| Piece | File | What it owns |
|---|---|---|
| Front door | `src/services/email.ts` | Facade. Import everything from here. |
| Transport | `src/services/email-transport.ts` | `sendEmail`: DEMO_MODE, gate, capture, SMTP. |
| Kind registry | `src/services/email-kinds.ts` | The branded shell + every registered message. |
| Dev mailbox | `src/services/email-mailbox.ts` | In-memory capture buffer. The test seam. |
| Gate | `src/services/communications.service.ts` | Org toggle + per-user preference + suppression list. |
| Admin routes | `src/api/routes/email/index.ts` | Kind list, preview, test send, toggles. |

**Your ONE integration point is a kind:**

```ts
registerEmailKind<{ name: string; url: string }>({
  kind: "welcome",
  description: "Sent once after a user's first sign-in.",
  subject: (d) => `Welcome, ${d.name}`,
  text: (d) => `Welcome, ${d.name}.\n\n${d.url}`,
  body: (d) => ({ previewText: "Welcome", html: `<p>Hi ${escapeHtml(d.name)}</p>` }),
  sample: () => ({ name: "Sample Person", url: "https://example.invalid" }),
});

await sendEmailKind({ kind: "welcome", to, data: { name, url }, organizationId });
```

Registration buys the shell, the gate, mailbox capture tagged with the
kind, `GET /api/email/kinds/:kind/preview`, and `POST /api/email/test`.
Register from a module `main.ts` imports (same rule as the inbound-email
extraction profile) or the preview and test surfaces will not see it.
**Escape every interpolated value** with `escapeHtml`; the shell does not
sanitize what a kind hands it.

Invariants (each one is a defect someone already shipped):

- **`authCritical` is only for mail a person cannot sign in without**:
  the OTP code, an invite link, a portal link. `authIntent` is narrower:
  only the five sign-in intents Chipp delivers (an invite is one:
  `invitation`, the link and its expiry, nothing free-form). Auth-critical mail skips
  the communications gate.
  Suppressing it is a lockout, not a quiet inbox. Marking a digest
  auth-critical "to make sure it lands" makes the toggle a lie.
- **`sendTestEmail()` bypasses the gate on purpose.** It is the "prove
  delivery works" path; running it through the org toggle makes it fail
  exactly when an admin is debugging why mail stopped. Keep that ordering.
- **The org toggle and the personal toggle live on separate endpoints.**
  The personal one must be writable by any signed-in user including a
  viewer; the org one must not. One PATCH with two optional fields would
  widen the wrong gate.
- **The gate fails OPEN and logs an error.** Dropping customer mail during
  an unrelated DB outage is worse than one extra notification.
- **Ordinary mail carries a real one-click unsubscribe (RFC 8058).** The
  transport adds `List-Unsubscribe: <https://<app>/api/unsubscribe/<signed
  token>>` (plus `<mailto:...>` only when `EMAIL_UNSUBSCRIBE_MAILTO` names an
  inbox something processes) and `List-Unsubscribe-Post:
  List-Unsubscribe=One-Click`. The POST turns off that workspace's ordinary
  mail to the address (an app user's own switch, or a workspace-scoped
  suppression row). A GET only shows a confirm button, so link scanners
  cannot unsubscribe anyone. Auth-critical mail carries neither header.
- **A suppressed address gets no ordinary mail.** `email_suppressions` is
  read by the gate on every ordinary send: hard bounces and complaints
  app-wide, unsubscribes per workspace.
- **Assert on the mailbox, never on console output.** `listCapturedEmails()`
  / `lastCapturedEmail({ kind })` in tests; `GET /api/dev/mailbox` in the
  browser or sandbox (`DELETE` to clear first, `?kind=` / `?to=` / `?since=`
  to filter). A suppressed message is ABSENT from the buffer, which is the
  cleanest way to assert "we did not send that".
- **`/api/dev/mailbox` rides the fail-closed dev gate** (`ALCHEMIST_DEV_ROUTES`),
  the same one as instant-login and DB reset. Capture is also off on a pod
  with real SMTP and no dev flag. Do not relax either.

**Scheduled alerts** ("email me before X expires") have a scaffold:
`src/services/expiration-digest.ts` plus `src/jobs/expiration-digest.ts`.
Register an expiring-records provider and you get the schedule, the
job lock, the branded digest, and the gating. It is dormant until you
do. The digest is ORDINARY mail, so a muted org gets nothing. Copy the
job's shape (setTimeout not setInterval, `withJobLock` from
`src/lib/job-lock.ts`, dead under `NODE_ENV=test`, started under
`runsBackgroundWork` in `main.ts`) for any other periodic alert.

## Email — event-driven + scheduled, always through the outbox

Every customer project wants "email the user when X happens" and "email
users every <cadence>". Both exist in the template; do not build a second
mechanism. Composition and delivery are two separate paved roads:

- **Compose** with the kind registry (`registerEmailKind` + `renderEmailKind`
  in `src/services/email-kinds.ts`): the branded shell, the preview route
  and the admin test-send come free. Never hand-roll email markup.
- **Deliver** through the outbox: `enqueueEmail()` writes an `email_outbox`
  row and the job runner sends it with retries. `sendEmail` / `sendEmailKind`
  synchronously is for auth-critical mail only (OTP, invite, portal link).
  The transport still applies the per-org communications gate to every
  outbox row, so a muted workspace stays muted.

### Event-driven: `enqueueEmail()` after the state change

```ts
import { enqueueEmail } from "@/services/email-outbox.service.ts";
import { brandedEmailShell, escapeHtml, EMAIL_STYLE } from "@/services/email.ts";

await db.transaction().execute(async (trx) => {
  const order = await trx.updateTable("orders").set({ status: "shipped" })...;
  await enqueueEmail({
    to: customer.email,
    subject: `Order ${order.number} shipped`,
    text: `Your order is on its way.`,
    html: brandedEmailShell({ bodyHtml: `<p style="font-family:${EMAIL_STYLE.sans}">…</p>` }),
    organizationId: order.organizationId,
    userId: customer.id,
    idempotencyKey: `order.shipped:${order.id}`,   // never double-send
    source: "order.shipped",                       // becomes the gate/mailbox `kind`
  }, trx);                                          // atomic with the update
});
```

(When the change is already published as an event, enqueue from the event
handler instead; the outbox is the delivery half either way.)

Pass the transaction so the email is queued if and only if the state
change commits. `sendAt` schedules a one-off future send (reminders,
"your trial ends in 3 days"). The runner delivers within one tick
(`JOBS_TICK_MS`, default 30 s), retries SMTP failures with 1m/5m/30m/2h/12h
backoff, and marks the row `failed` after `maxAttempts` (default 5).

### Scheduled: a job handler on a cron

1. Write a handler in `src/jobs/handlers/<kind>.ts` and register it:

   ```ts
   import { defineJob } from "@/jobs/registry.ts";

   defineJob("weekly_report", async (ctx) => {
     const owners = await db.selectFrom("users")
       .select(["id", "email"])
       .where("organizationId", "=", ctx.organizationId!)
       .where("role", "=", "owner").execute();
     for (const o of owners) {
       await ctx.enqueueEmail({
         to: o.email, userId: o.id,
         subject: "Your week in numbers", text: "...", html: "...",
         idempotencyKey: ctx.idempotencyKey(o.id),   // safe on re-run
       });
     }
     return { summary: `queued ${owners.length}` };
   }, { description: "Monday summary to org owners" });
   ```

2. Add `import "./handlers/weekly-report.ts";` to `src/jobs/index.ts`.
3. Create the schedule (from a settings route, onboarding, or a seed):

   ```ts
   await createScheduledJob({
     kind: "weekly_report",
     cron: "0 9 * * 1",             // 5-field cron
     timezone: "America/Chicago",   // IANA zone; DST handled
     organizationId: org.id,        // or null for an app-global job
     payload: { includeRevenue: true },
   });
   ```

`org_digest` in `src/jobs/handlers/org-digest.ts` is the reference
implementation. Handler rules: finish inside `JOBS_HANDLER_TIMEOUT_MS`
(60 s), do work by enqueueing not inline, always key emails with
`ctx.idempotencyKey(...)`. A throwing handler is recorded in `job_history`
and `scheduled_jobs.last_error`; the schedule still advances. Minimum
cadence is `JOBS_MIN_INTERVAL_SECONDS` (5 min). Missed fires while the app
was down collapse into one run.

### Verifying (agent recipe)

```bash
# time-travel to next Monday 09:00 UTC and run one tick
curl -sS -X POST -H 'Content-Type: application/json' \
  -d '{"now":"2026-09-28T09:00:00Z"}' http://localhost:__API_PORT__/api/dev/jobs/tick
# every queued/sent row, newest first
curl -sS http://localhost:__API_PORT__/api/dev/outbox | jq '.data[] | {toEmail, subject, status, source}'
```

Without SMTP the delivery step logs the email to the console and marks
the row `sent`, so the flow is verifiable end-to-end in dev.

### Sender identity — the two env vars and the fallback

Mail composes as `${BRAND.fromName} <${BRAND.fromEmail}>`. The address comes
from env the platform injects; nothing in this repo composes a From header
by hand.

- `EMAIL_FROM` — the sender this app's own provider sends as. It is part
  of the provider credential group (`EMAIL_FROM`, `SMTP_HOST`,
  `SMTP_USERNAME`, `SMTP_PASSWORD`, optional `SMTP_PORT`) the project brings
  with `request_credentials`. There is no shared platform sender or SMTP
  login any more.

Sign-in mail does not need a provider: Chipp delivers it from its own sender
(see above). A pod with no provider of its own gets SMTP settings that point
at Chipp's sign-in mail relay, which delivers sign-in mail only and accepts
and drops anything else. Ordinary mail never rewrites its sender: when the
provider refuses it (`sender domain not verified`), the outbox marks the row
`failed` immediately, with the fix in `last_error`.

In dev, `GET /api/dev/info` returns an `email` block with the effective
From; `GET /api/dev/outbox` returns the same snapshot next to the rows.

A campaign (newsletter) refuses to send from a shared Chipp domain; see the
next section.
