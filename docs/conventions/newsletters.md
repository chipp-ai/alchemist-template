# Newsletters and bulk email

## Newsletters and bulk email: the mailing-list paved road (do NOT rebuild this)

**When a ticket says "send a newsletter", "email our list", "announce this
to all subscribers", "import our subscribers from Kajabi / Mailchimp /
ConvertKit", or "let people sign up for updates", use
`src/services/mailing/`.** Never loop over `enqueueEmail` for a list, never
add a second contacts table, never hand-roll an unsubscribe link.

Why it exists (2026-11-04): an app built from this template imported a
12,000-contact CSV from a previous platform and mailed all of it the next
day from the shared `noreply@chipp.ai`. One week: 6 spam complaints and
1,044 hard bounces (8.7%) on a sender every app shares, sign-in codes
included. Every piece below stops one part of that.

| Piece | File | What it owns |
|---|---|---|
| Front door | `src/services/mailing/index.ts` | Facade + `mailingReadiness()`. Import from here. |
| Sender policy | `src/services/mailing/sender-policy.ts` | Campaigns never send from a shared sender. |
| Contacts | `src/services/mailing/contacts.service.ts` | `email_contacts`, the `email_contacts` import, `addSignupContact`, `addManualContact`. |
| Hygiene | `src/services/mailing/hygiene.ts` | Invalid, typo-domain, test/role and reserved addresses; optional bounded MX check. |
| Campaigns | `src/services/mailing/campaign.service.ts` | Draft, send/schedule, warm-up ramp, thresholds, pause/resume/cancel, report. |
| Suppression | `src/services/mailing/suppression.service.ts` | Provider bounces/complaints, one-click unsubscribe. |
| Unsubscribe links | `src/services/mailing/unsubscribe-token.ts` | Signed RFC 8058 URLs + headers. |
| Tables | `db/migrations/20261104160000_mailing_lists.sql` | `email_contacts`, `email_campaigns`, `email_campaign_recipients`, `email_suppressions`. |
| Admin routes | `src/api/routes/mailing/index.ts` | `/api/mailing/*`, capability `email.broadcast` (admin+). |
| Unsubscribe | `src/api/routes/unsubscribe/index.ts` | `GET`/`POST /api/unsubscribe/:token`, public. |
| Provider feedback | `src/api/routes/email-feedback/index.ts` | `POST /api/email-feedback`, bearer `EMAIL_FEEDBACK_TOKEN`. |
| Agent tools | `src/services/agent-tools/mailing-tools.ts` | Read-only: readiness, list summary, campaigns, report. |

```
GET    /api/mailing/readiness              can campaigns send? what to fix
GET    /api/mailing/contacts               ?status=&origin=&limit=&offset=
GET    /api/mailing/contacts/counts        subscribed / unsubscribed / suppressed / cold
POST   /api/mailing/contacts               one by hand { email, firstName?, lastName?, attestation }
GET    /api/mailing/campaigns              list
POST   /api/mailing/campaigns              draft { name, subject, text, html? }
GET    /api/mailing/campaigns/:id          counts, warm-up, skipped recipients with reasons
PATCH  /api/mailing/campaigns/:id          edit a draft
POST   /api/mailing/campaigns/:id/send     now, or { sendAt } to schedule
POST   /api/mailing/campaigns/:id/pause | resume | cancel
```

Bulk lists come in through the import wizard:
`<ImportWizard definition="email_contacts" />`. A signup form calls
`addSignupContact({ organizationId, email, firstName })`.

Invariants (each one is part of the 2026-11-04 incident):

- **A campaign never sends from the shared platform sender.** Send and
  schedule answer 409 `SENDER_DOMAIN_REQUIRED` when `EMAIL_FROM` is the
  platform sender, any address on a shared domain (`chipp.ai`, `adaas.dev`,
  the `PLATFORM_EMAIL_FROM` domain, `ALCHEMIST_DOMAIN`), or the placeholder.
  The message tells the builder how to fix it: in the Software Factory,
  the project's Settings, Emails panel, add a domain they own, add the DNS
  records, click Verify; the platform then redeploys with `EMAIL_FROM` on
  that domain. The pod has no "verified" flag: the platform only sets
  `EMAIL_FROM` to a customer domain after the provider confirmed it, so
  "not a shared domain" IS the signal. The runner re-checks at every
  release and pauses a campaign whose sender became shared. Transactional
  mail (OTP, invites, receipts, reminders) is untouched. With no SMTP
  (dev), campaigns run into the dev mailbox. Never relax this check to
  "just get the newsletter out".
- **An import must say where the list came from and attest opt-in.** The
  `email_contacts` definition requires an attestation; the statement is
  copied onto every contact (`consent_source`, `consent_source_detail`,
  `consent_collected_in_app`, `consent_attested_by/at`, `import_session_id`)
  and the session. A list not collected in this app gets a clear warning
  in the wizard and must name its source.
- **Hygiene runs at import AND at the first send.** Invalid addresses,
  typo domains (gmail.co, hotmial.com, tahoo.com, `.con`, ...), test and
  system mailboxes (probe@, test@, noreply@, postmaster@, ...), reserved
  domains and suppressed addresses are skipped with a reason. info@ and
  sales@ are real inboxes and pass. Dedupe is structural: one contact per
  (workspace, lowercased email), one recipient per contact per campaign.
  `MAILING_MX_CHECK=1` adds an MX lookup (at most 200 distinct domains,
  1.5 s each, a resolver error never rejects an address).
- **A re-import never re-subscribes anyone.** An existing contact gets its
  names updated; status, origin and consent stay. Only the person signing
  up again through the app (`addSignupContact`) undoes their own
  unsubscribe. A bounce or complaint is never undone by an import.
- **Cold contacts ramp.** A non-signup contact never mailed before is cold.
  Its first campaign releases cold recipients in `WARMUP_BATCH_SIZES`
  (50, 200, 500, 1000, 2500, 5000, then 5000 each), at most one batch per
  `WARMUP_BATCH_INTERVAL_MS` (4 h). Before each batch, once
  `WARMUP_MIN_SAMPLE` (20) cold sends are out, the hard-bounce rate
  (`WARMUP_MAX_HARD_BOUNCE_RATE`, 2%) and complaint rate
  (`WARMUP_MAX_COMPLAINT_RATE`, 0.1%) are checked; over either, the
  campaign pauses with the numbers in `pausedReason`. Resume restarts the
  measuring window. Signups and already-mailed contacts are not held back.
  The incident's list would have paused after 50 sends.
- **The thresholds only see reported feedback.** Hard bounces and
  complaints reach the app through `POST /api/email-feedback` (body
  `{ events: [{ type: "hard_bounce" | "complaint" | "soft_bounce" |
  "unsubscribe", email, campaignId?, organizationId?, occurredAt?, detail? }] }`,
  max 500). A hard bounce or complaint suppresses the address app-wide,
  marks its contacts suppressed, and lands on its latest campaign send; a
  soft bounce changes nothing. `EMAIL_FEEDBACK_TOKEN` unset = endpoint OFF
  (401). **The platform does not call it yet**; until it does,
  `GET /api/mailing/readiness` says `feedbackConnected: false` and the ramp
  only spaces sends out. Do not wire a provider webhook here by hand.
- **Every campaign email has an unsubscribe link in the footer** and the
  transport's one-click headers. Delivery is the outbox (idempotency key
  `campaign:<id>:<contactId>`, source `campaign:<id>`), so the gate, the
  suppression list and retries all apply.
- **Starting, pausing and resuming are not agent tools.** They mail real
  people; they stay buttons a person presses. The agent tools are read-only.

Verifying locally: create contacts and a campaign through the routes, then
`POST /api/dev/jobs/tick` with `{ "now": ... }` to step through warm-up
batches (the tick advances campaigns before it delivers the outbox), and
read `GET /api/mailing/campaigns/:id` and `GET /api/dev/outbox`.
