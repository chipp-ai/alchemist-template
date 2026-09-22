/**
 * `org_digest` — the reference scheduled-email handler.
 *
 * Emails every member of the organization a short team summary: member
 * count, who joined since the last run, and pending invites. It exists to
 * show the shape every customer digest takes; replace the data with your
 * domain's numbers and keep the skeleton:
 *
 *   1. read what changed since ctx.job.lastRunAt
 *   2. render through a registered email KIND (the branded shell, the
 *      preview route and the admin test-send all come from the registry;
 *      never hand-roll markup)
 *   3. one ctx.enqueueEmail per recipient, keyed by ctx.idempotencyKey(userId)
 *   4. return a summary line
 *
 * Payload (all optional):
 *   { "subject": "Your weekly team update", "intro": "Here's what happened." }
 *
 * Register a schedule for an org:
 *
 *   await createScheduledJob({
 *     kind: "org_digest",
 *     cron: "0 9 * * 1",
 *     timezone: "America/Chicago",
 *     organizationId: org.id,
 *   });
 */

import { db } from "@/db/client.ts";
import { defineJob } from "@/jobs/registry.ts";
import { escapeHtml, registerEmailKind, renderEmailKind } from "@/services/email.ts";
import { EMAIL_INK, EMAIL_MUTED, EMAIL_SANS, EMAIL_SERIF } from "@/services/email-kinds.ts";
import { BRAND } from "@/config/brand.ts";
import { BadRequestError } from "@/utils/errors.ts";
import { roleLabel } from "@/lib/roles.ts";

export const ORG_DIGEST_EMAIL_KIND = "org_digest";

export interface OrgDigestEmailData {
  organizationName: string;
  subject: string;
  intro: string;
  memberCount: number;
  /** "Name (Role)" labels of people who joined since the last run. */
  joined: string[];
  /** "email (Role)" labels of invites still pending. */
  pendingInvites: string[];
  sinceLabel: string;
}

const listItem = (html: string) =>
  `<li style="margin:0 0 6px;font-family:${EMAIL_SANS};font-size:14px;line-height:1.5;color:${EMAIL_INK};">${html}</li>`;

registerEmailKind<OrgDigestEmailData>({
  kind: ORG_DIGEST_EMAIL_KIND,
  description: "Scheduled team digest: member count, recent joins, pending invites.",
  subject: (d) => d.subject,
  text: (d) =>
    [
      d.intro,
      d.intro ? "" : null,
      `${d.organizationName} has ${d.memberCount} member${d.memberCount === 1 ? "" : "s"}.`,
      d.joined.length
        ? `Joined since ${d.sinceLabel}: ${d.joined.join(", ")}.`
        : `No one joined since ${d.sinceLabel}.`,
      d.pendingInvites.length
        ? `Pending invites: ${d.pendingInvites.join(", ")}.`
        : "No pending invites.",
    ].filter((l): l is string => l !== null).join("\n"),
  body: (d) => ({
    previewText: `${d.organizationName}: ${d.memberCount} member${
      d.memberCount === 1 ? "" : "s"
    }, ${d.joined.length} joined, ${d.pendingInvites.length} pending`,
    html: `
      <h1 style="margin:0 0 10px;font-family:${EMAIL_SERIF};font-size:31px;font-weight:600;line-height:1.1;color:${EMAIL_INK};">${
      escapeHtml(d.organizationName)
    }</h1>
      ${
      d.intro
        ? `<p style="margin:0 0 18px;font-family:${EMAIL_SANS};font-size:15px;line-height:1.55;color:${EMAIL_MUTED};">${
          escapeHtml(d.intro)
        }</p>`
        : ""
    }
      <ul style="margin:0 0 18px;padding-left:20px;">
        ${listItem(`<strong>${d.memberCount}</strong> member${d.memberCount === 1 ? "" : "s"}`)}
        ${
      listItem(
        d.joined.length ? `Joined recently: ${escapeHtml(d.joined.join(", "))}` : "No new members",
      )
    }
        ${
      listItem(
        d.pendingInvites.length
          ? `Pending invites: ${escapeHtml(d.pendingInvites.join(", "))}`
          : "No pending invites",
      )
    }
      </ul>
      <p style="margin:0;font-family:${EMAIL_SANS};font-size:12px;line-height:1.5;color:${EMAIL_MUTED};">You receive this because you are a member of ${
      escapeHtml(d.organizationName)
    }.</p>
    `,
  }),
  sample: () => ({
    organizationName: "Acme Inc",
    subject: `Your ${BRAND.name} team update`,
    intro: "Here is what changed on the team this week.",
    memberCount: 12,
    joined: ["Grace Hopper (Editor)", "Ada Lovelace (Admin)"],
    pendingInvites: ["linus@example.com (Editor)"],
    sinceLabel: "Mon Sep 15 2026",
  }),
});

defineJob("org_digest", async (ctx) => {
  if (!ctx.organizationId) {
    throw new BadRequestError("org_digest must be scheduled for an organization");
  }
  const since = ctx.job.lastRunAt ?? new Date(ctx.now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const subject = typeof ctx.payload.subject === "string" && ctx.payload.subject.trim()
    ? ctx.payload.subject.trim()
    : `Your ${BRAND.name} team update`;
  const intro = typeof ctx.payload.intro === "string" ? ctx.payload.intro.trim() : "";

  const [org, members, pendingInvites] = await Promise.all([
    db
      .selectFrom("organizations")
      .select(["id", "name"])
      .where("id", "=", ctx.organizationId)
      .executeTakeFirst(),
    db
      .selectFrom("users")
      .select(["id", "email", "name", "role", "createdAt"])
      .where("organizationId", "=", ctx.organizationId)
      .orderBy("createdAt", "asc")
      .execute(),
    db
      .selectFrom("invites")
      .select(["email", "role"])
      .where("organizationId", "=", ctx.organizationId)
      .where("acceptedAt", "is", null)
      .where("revokedAt", "is", null)
      .where("expiresAt", ">", ctx.now)
      .execute(),
  ]);
  if (!org) return { summary: "organization no longer exists", emailed: 0 };
  if (members.length === 0) return { summary: "no members", emailed: 0 };

  const rendered = renderEmailKind<OrgDigestEmailData>(ORG_DIGEST_EMAIL_KIND, {
    organizationName: org.name,
    subject,
    intro,
    memberCount: members.length,
    joined: members
      .filter((m) => m.createdAt > since)
      .map((m) => `${m.name ?? m.email} (${roleLabel(m.role)})`),
    pendingInvites: pendingInvites.map((i) => `${i.email} (${roleLabel(i.role)})`),
    sinceLabel: since.toDateString(),
  });

  let emailed = 0;
  for (const member of members) {
    const { created } = await ctx.enqueueEmail({
      to: member.email,
      userId: member.id,
      subject: rendered.subject,
      text: rendered.text,
      html: rendered.html,
      idempotencyKey: ctx.idempotencyKey(member.id),
    });
    if (created) emailed++;
  }
  return { summary: `queued ${emailed} of ${members.length} member emails`, emailed };
}, { description: "Team summary (members, joins, pending invites) to every org member" });
