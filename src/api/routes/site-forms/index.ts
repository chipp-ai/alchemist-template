/**
 * POST /api/site-forms/:name: the landing site's form sections.
 *
 * The form is defined in the landing content (landing/src/content/pages/),
 * rendered by landing/src/components/sections/Form.astro, and posted here.
 * The fields accepted are exactly the fields that form defines
 * (src/services/site-forms.service.ts).
 *
 * Two callers, one route:
 * - The HTML form posts application/x-www-form-urlencoded and needs no
 *   script. The answer is a 303 back to the page at
 *   `#form-<name>-<status>` (sent, invalid, limited); the page shows the
 *   matching message with :target.
 * - A script posts JSON and gets JSON: 201 { data: { status: "sent" } },
 *   400 with a message per bad field, 429 when limited, 404 for an unknown
 *   form.
 *
 * Abuse damping: a 32 KB body limit; the hidden `_website` honeypot (a hit
 * gets the normal success answer and stores nothing); a per-IP limit and a
 * site-wide limit (Redis fixed windows, fail-open when Redis is down).
 */

import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { rateLimit } from "@/lib/redis.ts";
import { clientIp } from "@/lib/client-ip.ts";
import { readCampaigns } from "@/lib/landing-site.ts";
import {
  attributionOf,
  type Campaign,
  campaignPagePath,
  selectCampaign,
} from "../../../../landing/src/lib/campaigns.ts";
import {
  createSiteFormSubmission,
  loadSiteForms,
  type RawSubmission,
  type SiteFormEntry,
  siteFormRecipients,
  validateSubmission,
} from "@/services/site-forms.service.ts";

export type SiteFormStatus = "sent" | "invalid" | "limited";

export const SITE_FORM_LIMITS = {
  perIp: { limit: 5, windowSeconds: 600 },
  site: { limit: 200, windowSeconds: 3600 },
} as const;

/** The honeypot field. People never see it; bots fill it. */
export const HONEYPOT_FIELD = "_website";

type Limiter = (
  name: string,
  opts: { limit: number; windowSeconds: number },
) => Promise<{ allowed: boolean }>;

/** A same-site page path to send the visitor back to, or the form's own page. */
function returnPath(raw: unknown, fallback: string): string {
  const p = typeof raw === "string" ? raw.trim() : "";
  return p.startsWith("/") && !p.startsWith("//") && !/[\s\\]/.test(p) && p.length <= 512
    ? p.split("#")[0]
    : fallback;
}

/**
 * Where the visitor came from, read from the Referer: the page URL the
 * browser sent the form from (same-site, so the browser keeps the query).
 * The UTM values and ad click ids, plus the landing campaign that URL
 * selects. Also the query to keep on the way back, so a visitor without
 * scripts returns to the same variant. Never throws.
 */
export function siteFormAttribution(
  referer: string | undefined,
  back: string,
  campaigns: Campaign[],
): { attribution: Record<string, string>; backQuery: string } {
  let url: URL;
  try {
    url = new URL(referer ?? "");
  } catch {
    return { attribution: {}, backQuery: "" };
  }
  // camelCase keys (utm_source -> utmSource): the CamelCasePlugin renames
  // nested JSONB keys on read, so this is how the row reads back.
  const attribution: Record<string, string> = {};
  for (const [k, v] of Object.entries(attributionOf(url.searchParams))) {
    attribution[k.replace(/_([a-z])/g, (_, ch: string) => ch.toUpperCase())] = v;
  }
  const campaign = selectCampaign(campaigns, url.pathname, url.searchParams);
  if (campaign) {
    attribution.landingCampaign = campaign.id;
    attribution.landingCampaignName = campaign.name;
  }
  const samePage = campaignPagePath(url.pathname) === campaignPagePath(back.split("?")[0]);
  const backQuery = samePage && !back.includes("?") && url.search.length <= 1024 ? url.search : "";
  return { attribution, backQuery };
}

async function readBody(c: Context): Promise<{ isForm: boolean; data: RawSubmission | null }> {
  const type = c.req.header("content-type") ?? "";
  if (type.includes("application/json")) {
    const json = await c.req.json().catch(() => null);
    if (!json || typeof json !== "object" || Array.isArray(json)) {
      return { isForm: false, data: null };
    }
    const data: RawSubmission = {};
    for (const [k, v] of Object.entries(json as Record<string, unknown>)) {
      if (typeof v === "string") data[k] = v;
      else if (typeof v === "boolean" || typeof v === "number") data[k] = String(v);
      else if (Array.isArray(v)) data[k] = v.filter((x): x is string => typeof x === "string");
    }
    return { isForm: false, data };
  }
  const form = await c.req.parseBody({ all: true }).catch(() => null);
  if (!form) return { isForm: true, data: null };
  const data: RawSubmission = {};
  for (const [k, v] of Object.entries(form)) {
    if (typeof v === "string") data[k] = v;
    else if (Array.isArray(v)) data[k] = v.filter((x): x is string => typeof x === "string");
  }
  return { isForm: true, data };
}

export interface SiteFormsRouteOptions {
  /** The form definitions. Default: read once from landing/src/content/pages/. */
  forms?: () => Map<string, SiteFormEntry>;
  /** Default: the shared Redis fixed-window limiter. */
  limiter?: Limiter;
  /** Default: LEAD_NOTIFICATION_EMAIL, else the first owner account. */
  recipients?: () => Promise<string[]>;
  /** The landing campaigns, for attribution. Default: read once from landing/src/content/campaigns/. */
  campaigns?: () => Campaign[];
}

export function createSiteFormsRoutes(options: SiteFormsRouteOptions = {}): Hono {
  let cached: Map<string, SiteFormEntry> | null = null;
  const forms = options.forms ?? (() => (cached ??= loadSiteForms()));
  const limiter: Limiter = options.limiter ?? rateLimit;
  const recipients = options.recipients ?? siteFormRecipients;
  let cachedCampaigns: Campaign[] | null = null;
  const campaigns = options.campaigns ?? (() => (cachedCampaigns ??= readCampaigns()));

  const routes = new Hono();
  routes.post("/:name", bodyLimit({ maxSize: 32 * 1024 }), async (c) => {
    const entry = forms().get(c.req.param("name"));
    if (!entry) {
      return c.json({ error: "No form with that name on this site.", code: "NOT_FOUND" }, 404);
    }

    const { isForm, data } = await readBody(c);
    const page = returnPath(data?._page, entry.pagePath);
    const { attribution, backQuery } = siteFormAttribution(
      c.req.header("referer"),
      page,
      campaigns(),
    );
    const back = `${page}${backQuery}`;
    const answer = (
      status: SiteFormStatus,
      httpStatus: 201 | 400 | 429,
      extra: Record<string, unknown> = {},
    ) =>
      isForm
        ? c.redirect(`${back}#form-${entry.form.name}-${status}`, 303)
        : httpStatus === 201
        ? c.json({ data: { status } }, 201)
        : c.json({
          error: extra.error,
          code: status === "limited" ? "RATE_LIMITED" : "VALIDATION_ERROR",
          ...extra,
        }, httpStatus);

    if (!data) return answer("invalid", 400, { error: "The form data could not be read." });
    if (typeof data[HONEYPOT_FIELD] === "string" && data[HONEYPOT_FIELD]!.trim() !== "") {
      return answer("sent", 201);
    }

    const perIp = await limiter(
      `site-forms:ip:${clientIp(c.req) ?? "unknown"}`,
      SITE_FORM_LIMITS.perIp,
    );
    const site = await limiter("site-forms:site", SITE_FORM_LIMITS.site);
    if (!perIp.allowed || !site.allowed) {
      return answer("limited", 429, {
        error: "Too many messages. Please try again in a few minutes.",
      });
    }

    const result = validateSubmission(entry.form, data);
    if (!result.ok) {
      return answer("invalid", 400, {
        error: "Some fields need another look.",
        fields: result.errors,
      });
    }

    await createSiteFormSubmission({
      entry,
      values: result.values,
      userAgent: c.req.header("user-agent") ?? null,
      recipients: await recipients(),
      attribution,
    });
    return answer("sent", 201);
  });
  return routes;
}

export const siteFormsRoutes = createSiteFormsRoutes();
