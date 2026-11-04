/**
 * Agent tools for mailing lists. Read-only on purpose: starting, pausing
 * or resuming a campaign mails real people and spends the app's sender
 * reputation, so those stay buttons a person presses in the app.
 *
 * Every handler scopes by the session user's organization (CWE-639).
 */

import { registerAgentTool } from "@/services/agent-tools/registry.ts";
import {
  campaignReport,
  contactCounts,
  listCampaigns,
  mailingReadiness,
} from "@/services/mailing/index.ts";

registerAgentTool({
  name: "mailing_readiness",
  description: "Whether this app can send newsletters/campaigns right now, and if not, what the " +
    "owner must do (usually: verify a sending domain). Also the warm-up thresholds.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  capability: "email.broadcast",
  write: false,
  handler: () => Promise.resolve(mailingReadiness()),
});

registerAgentTool({
  name: "mailing_list_summary",
  description: "Counts of the workspace's mailing-list contacts: subscribed, unsubscribed, " +
    "suppressed, and cold (imported, never mailed).",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  capability: "email.broadcast",
  write: false,
  handler: async ({ user }) => await contactCounts(user.organizationId),
});

registerAgentTool({
  name: "list_campaigns",
  description: "The workspace's email campaigns, newest first, with status and pause reason.",
  inputSchema: {
    type: "object",
    properties: { limit: { type: "integer", minimum: 1, maximum: 100 } },
    additionalProperties: false,
  },
  capability: "email.broadcast",
  write: false,
  handler: async ({ user }, args) => {
    const rows = await listCampaigns({
      organizationId: user.organizationId,
      limit: typeof args.limit === "number" ? args.limit : 25,
    });
    return {
      campaigns: rows.map((c) => ({
        id: c.id,
        name: c.name,
        subject: c.subject,
        status: c.status,
        pausedReason: c.pausedReason,
        scheduledAt: c.scheduledAt?.toISOString() ?? null,
        createdAt: c.createdAt.toISOString(),
      })),
    };
  },
});

registerAgentTool({
  name: "get_campaign_report",
  description: "One campaign's delivery report: counts by status, the warm-up's next batch, " +
    "and up to 200 skipped recipients with the reason each was skipped.",
  inputSchema: {
    type: "object",
    properties: { campaignId: { type: "string", format: "uuid" } },
    required: ["campaignId"],
    additionalProperties: false,
  },
  capability: "email.broadcast",
  write: false,
  handler: async ({ user }, args) =>
    await campaignReport({ id: String(args.campaignId), organizationId: user.organizationId }),
});
