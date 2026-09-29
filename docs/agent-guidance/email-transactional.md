# Transactional email

This project already sends email. Do not add a second SMTP client, a second
outbox, or a mail library. Use the modules below.

## Which call to use

| Need | Call |
|------|------|
| Mail caused by an event (order shipped, invite accepted) | `enqueueEmail()` in `src/services/email-outbox.service.ts`, inside the same transaction as the state change |
| Mail on a schedule (digest, reminder) | a `scheduled_jobs` handler in `src/jobs/` that calls `ctx.enqueueEmail` |
| A branded message kind (invite, OTP, portal link) | `sendEmailKind()` in `src/services/email-kinds.ts`; register new kinds with `registerEmailKind()` |
| A genuinely one-off message | `sendEmail()` in `src/services/email-transport.ts` |

Import through `@/services/email.ts` where the name is exported there.

## Sending at most once

`enqueueEmail({ idempotencyKey })` is the dedupe. A second enqueue with the
same key returns the first row and sends nothing. Use a key that names the
event and the recipient, for example `order.shipped:<orderId>` or
`digest:<userId>:<yyyy-mm-dd>`. A retried job or a double-clicked button then
cannot send twice.

The outbox retries SMTP failures with backoff (`RETRY_BACKOFF_SECONDS`) and
fails a row at once when the sender domain is rejected, because retrying the
same From cannot succeed.

## What sendEmail already does

In order: demo-mode suppression, the communications gate (org toggle and
per-user preference, skipped for auth-critical mail), capture in the dev
mailbox, reserved-recipient suppression, then SMTP. Addresses at
`example.com`, `example.net`, `example.org`, `test.com`, or any `.test`,
`.example`, `.invalid` or `.localhost` domain never reach SMTP
(`isReservedRecipientAddress`). They still land in the dev mailbox, so tests
can assert on them.

## Checking that mail went out

- In tests and dev: `lastCapturedEmail()` / `listCapturedEmails()` from
  `@/services/email.ts`.
- In any environment: read the `email_outbox` row (`status`, `attempts`,
  `last_error`), or `GET /api/dev/outbox` where dev routes are on.

## Credentials

`SMTP_HOST`, `SMTP_PORT`, `SMTP_USERNAME` and `SMTP_PASSWORD` are per-project
deployment env vars. Never hardcode them and never share one account across
projects. Without them the app still runs: mail is captured and logged, not
delivered. The From address comes from `src/config/brand.ts`.
