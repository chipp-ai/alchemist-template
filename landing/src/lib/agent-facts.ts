/**
 * What AI agents read about the product, built from site.json alone (2026-11-04).
 *
 * Answer engines (ChatGPT, Claude, Perplexity) and coding agents pick a
 * product when they can say in one line what it is, read its facts as data,
 * and find how to connect to it. This module turns the optional site.json
 * fields below into those pieces. Every field is optional: a site without
 * one simply has no sentence, section or file for it.
 *
 *   category      { name, audience }  -> "<name> is the <category> for <audience>."
 *                                         under the home H1, in JSON-LD and llms.txt
 *   useCases      [{ title, body }]   -> "What can you use <name> for?" section
 *   alternatives  [{ name, summary, chooseUs?, chooseThem? }]
 *                                      -> "How does <name> compare?" section
 *   agents        { mcp: { url, name? }, openapi, docs, setupPrompt }
 *                                      -> "Use <name> with your AI agent" section,
 *                                         /.well-known/api-catalog, llms.txt links
 *   sameAs        ["https://github.com/acme", ...] -> Organization.sameAs
 *   pricing.currency  "USD"            -> Offer.priceCurrency when a price has no symbol
 *
 * Pure: no site.json import, no Astro, so the node tests import it directly.
 */
import type { SiteBlock, SiteContent, SiteFaq, SitePlan } from "./site";

export interface SiteCategory {
  /** The category, e.g. "shipment tracking board". "the" is added unless it starts with an article. */
  name: string;
  /** Who it is for, e.g. "freight brokers". */
  audience: string;
}

export interface SiteAlternative {
  /** The other option: a product, a kind of tool, or "spreadsheets". */
  name: string;
  /** How the two differ, in one or two plain sentences (100 words or less). */
  summary: string;
  /** When this product is the better pick. */
  chooseUs?: string;
  /** When the other option is the better pick. Be honest. */
  chooseThem?: string;
}

export interface SiteAgents {
  /** The project's MCP server. The template's own is "/api/mcp" when ALCHEMIST_FEATURE_MCP is on. */
  mcp?: { url: string; name?: string } | null;
  /** The OpenAPI document, e.g. "/openapi.json". */
  openapi?: string | null;
  /** Human-readable API or developer docs. */
  docs?: string | null;
  /** A ready prompt a person pastes into their agent. Generated from the fields above when empty. */
  setupPrompt?: string | null;
}

/** The fields this module adds to site.json. */
export interface AgentFactsFields {
  category?: SiteCategory | null;
  useCases?: SiteBlock[];
  alternatives?: SiteAlternative[];
  agents?: SiteAgents | null;
  sameAs?: string[];
}

const trim = (s: unknown): string => (typeof s === "string" ? s.trim() : "");
const oneLine = (s: unknown): string => trim(s).replace(/\s+/g, " ");

/** `base` + `path` when `path` is site-relative and the base is known; else `path` as is. */
export function withBase(base: string, path: string): string {
  if (!path.startsWith("/") || path.startsWith("//")) return path;
  const b = base.replace(/\/+$/, "");
  return b ? `${b}${path}` : path;
}

/** "Acme is the shipment tracking board for freight brokers." or "" when either part is missing. */
export function categoryStatement(c: SiteContent): string {
  const name = oneLine(c.category?.name).replace(/\.$/, "");
  const audience = oneLine(c.category?.audience).replace(/\.$/, "");
  if (!name || !audience || !oneLine(c.name)) return "";
  const article = /^(the|a|an)\s/i.test(name) ? "" : "the ";
  return `${oneLine(c.name)} is ${article}${name} for ${audience}.`;
}

/** Use cases with both a title and a body. */
export function useCases(c: SiteContent): SiteBlock[] {
  return (c.useCases ?? []).filter((u) => trim(u?.title) && trim(u?.body));
}

/** Alternatives with both a name and a summary. */
export function alternatives(c: SiteContent): SiteAlternative[] {
  return (c.alternatives ?? []).filter((a) => trim(a?.name) && trim(a?.summary));
}

/** "Teams use Acme for A, B and C." from the use case titles. */
export function useCasesIntro(c: SiteContent, list: SiteBlock[] = useCases(c)): string {
  const titles = list.map((u) => lowerFirst(oneLine(u.title).replace(/\.$/, "")));
  if (titles.length === 0) return "";
  const joined = titles.length === 1 ? titles[0] : `${titles.slice(0, -1).join(", ")} and ${titles[titles.length - 1]}`;
  const who = oneLine(c.category?.audience) || "People";
  return `${who.charAt(0).toUpperCase()}${who.slice(1)} use ${oneLine(c.name)} for ${joined}.`;
}

/** Lower-case the first letter unless the first word looks like a name or acronym ("CRM", "Slack"). */
function lowerFirst(s: string): string {
  const first = s.split(/\s/)[0] ?? "";
  if (/^[A-Z][a-z]+$/.test(first)) return s.charAt(0).toLowerCase() + s.slice(1);
  return s;
}

// ── Pricing as data ──

const SYMBOLS: Record<string, string> = { "$": "USD", "€": "EUR", "£": "GBP", "¥": "JPY", "₹": "INR" };

/**
 * A plan's price as schema.org Offer fields. "$29" -> { price: "29", priceCurrency: "USD" };
 * "Free" -> { price: "0" }; "Contact us" -> null. A price with no symbol uses `currency`.
 */
export function parsePrice(raw: string, currency?: string): { price: string; priceCurrency?: string } | null {
  const s = oneLine(raw);
  if (!s) return null;
  if (/^free\b/i.test(s)) return { price: "0", ...(currency ? { priceCurrency: currency } : {}) };
  const m = /^([$€£¥₹])?\s*(\d[\d,]*(?:\.\d+)?)\s*([A-Z]{3})?\b/.exec(s);
  if (!m) return null;
  const code = m[3] ?? (m[1] ? SYMBOLS[m[1]] : undefined) ?? (currency ? currency.toUpperCase() : undefined);
  return { price: m[2].replace(/,/g, ""), ...(code ? { priceCurrency: code } : {}) };
}

/** One schema.org Offer per plan that has a readable price and currency (or is free). */
export function offersLd(c: SiteContent, pricingUrl: string): object[] {
  const plans: SitePlan[] = c.pricing?.plans ?? [];
  const currency = trim(c.pricing?.currency) || undefined;
  const out: object[] = [];
  for (const plan of plans) {
    const p = parsePrice(plan.price, currency);
    if (!p || (p.price !== "0" && !p.priceCurrency)) continue;
    const offer: Record<string, unknown> = { "@type": "Offer", name: oneLine(plan.name), price: p.price };
    if (p.priceCurrency) offer.priceCurrency = p.priceCurrency;
    if (oneLine(plan.description)) offer.description = oneLine(plan.description);
    if (pricingUrl) offer.url = pricingUrl;
    out.push(offer);
  }
  return out;
}

/** Fields added to the SoftwareApplication node: category, audience, features, offers. */
export function applicationExtras(c: SiteContent, base: string): Record<string, unknown> {
  const extra: Record<string, unknown> = {};
  const statement = categoryStatement(c);
  if (statement) {
    extra.disambiguatingDescription = statement;
    extra.applicationSubCategory = oneLine(c.category?.name);
    extra.audience = { "@type": "Audience", audienceType: oneLine(c.category?.audience) };
  }
  const features = (c.features ?? []).map((f) => oneLine(f.title)).filter(Boolean);
  if (features.length > 0) extra.featureList = features;
  const offers = offersLd(c, withBase(base, "/pricing/"));
  if (offers.length > 0) extra.offers = offers;
  return extra;
}

/** Organization.sameAs: only absolute https links. */
export function sameAs(c: SiteContent): string[] {
  return (c.sameAs ?? []).map(trim).filter((u) => /^https:\/\//i.test(u));
}

// ── Agent onboarding ──

export interface AgentSetup {
  /** A short server name for MCP configs: lower-case letters, digits and dashes. */
  serverName: string;
  mcpUrl: string | null;
  openapiUrl: string | null;
  docsUrl: string | null;
  /** `claude mcp add ...` for Claude Code, or null without an MCP server. */
  claudeCode: string | null;
  /** The mcpServers JSON for Cursor (.cursor/mcp.json) and other clients, or null. */
  mcpJson: string | null;
  /** The copy-paste setup prompt. */
  prompt: string;
}

/** A name safe for `claude mcp add` and mcpServers keys. */
export function serverNameFor(c: SiteContent): string {
  const raw = oneLine(c.agents?.mcp?.name) || oneLine(c.name);
  return raw.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "app";
}

/** What the agent section shows, or null when the project has no MCP server, OpenAPI spec or API docs. */
export function agentSetup(c: SiteContent): AgentSetup | null {
  const a = c.agents;
  const base = trim(c.url);
  const mcpUrl = trim(a?.mcp?.url) ? withBase(base, trim(a?.mcp?.url)) : null;
  const openapiUrl = trim(a?.openapi) ? withBase(base, trim(a?.openapi)) : null;
  const docsUrl = trim(a?.docs) ? withBase(base, trim(a?.docs)) : null;
  if (!mcpUrl && !openapiUrl && !docsUrl) return null;
  const serverName = serverNameFor(c);
  const claudeCode = mcpUrl ? `claude mcp add --transport http ${serverName} ${mcpUrl}` : null;
  const mcpJson = mcpUrl ? JSON.stringify({ mcpServers: { [serverName]: { url: mcpUrl } } }, null, 2) : null;
  return { serverName, mcpUrl, openapiUrl, docsUrl, claudeCode, mcpJson, prompt: setupPrompt(c, { mcpUrl, openapiUrl, docsUrl }) };
}

function setupPrompt(c: SiteContent, urls: { mcpUrl: string | null; openapiUrl: string | null; docsUrl: string | null }): string {
  const own = trim(c.agents?.setupPrompt);
  if (own) return own;
  const name = oneLine(c.name);
  const lines = [`Set up ${name} for me.`];
  const what = categoryStatement(c) || oneLine(c.definition?.what);
  if (what) lines.push(what);
  if (urls.mcpUrl) lines.push(`Connect its MCP server at ${urls.mcpUrl} (streamable HTTP). Sign in when it asks.`);
  if (urls.openapiUrl) lines.push(`Its REST API is described by the OpenAPI document at ${urls.openapiUrl}.`);
  if (urls.docsUrl) lines.push(`The developer docs are at ${urls.docsUrl}.`);
  lines.push(`Read ${withBase(trim(c.url), "/llms.txt")} for what ${name} does, then list the tools you can use and ask me what to do first.`);
  return lines.join(" ");
}

/**
 * /.well-known/api-catalog (RFC 9727): a linkset that points agents at the
 * API description and docs. Null when the project has no OpenAPI spec or docs.
 */
export function apiCatalog(c: SiteContent): object | null {
  const s = agentSetup(c);
  if (!s || (!s.openapiUrl && !s.docsUrl && !s.mcpUrl)) return null;
  const entry: Record<string, unknown> = { anchor: s.mcpUrl ?? s.openapiUrl ?? s.docsUrl };
  if (s.openapiUrl) entry["service-desc"] = [{ href: s.openapiUrl, type: "application/vnd.oai.openapi+json" }];
  if (s.docsUrl) entry["service-doc"] = [{ href: s.docsUrl, type: "text/html" }];
  entry["service-meta"] = [{ href: withBase(trim(c.url), "/llms.txt"), type: "text/plain" }];
  return { linkset: [entry] };
}

// ── llms.txt ──

export interface LlmsPage {
  path: string;
  label: string;
  description?: string;
}

/**
 * llms.txt (llmstxt.org): an H1, a one-paragraph summary in a blockquote,
 * then sections of links. `full` (llms-full.txt) adds every fact on the
 * home page as text: features, who it is for, use cases, comparisons, FAQ.
 */
export function llmsTxt(c: SiteContent, pages: LlmsPage[], opts: { full?: boolean; faq?: SiteFaq[] } = {}): string {
  const base = trim(c.url);
  const name = oneLine(c.name) || "Site";
  const out: string[] = [`# ${name}`, ""];
  const summary = [categoryStatement(c), oneLine(c.description) || oneLine(c.definition?.what)].filter(Boolean).join(" ");
  if (summary) out.push(`> ${summary}`, "");
  const def = [c.definition?.who, c.definition?.does].map(oneLine).filter(Boolean).join(" ");
  if (def) out.push(def, "");
  if (oneLine(c.asOf)) out.push(`Facts as of ${oneLine(c.asOf)}.`, "");

  const link = (label: string, url: string, note?: string) => `- [${oneLine(label)}](${url})${oneLine(note) ? `: ${oneLine(note)}` : ""}`;

  if (pages.length > 0) {
    out.push("## Pages", "");
    for (const p of pages) out.push(link(p.label || p.path, withBase(base, p.path), p.description));
    out.push("");
  }

  const plans = c.pricing?.plans ?? [];
  if (plans.length > 0 || oneLine(c.pricing?.answer)) {
    out.push("## Pricing", "");
    if (oneLine(c.pricing?.answer)) out.push(oneLine(c.pricing.answer), "");
    for (const plan of plans) {
      const price = [oneLine(plan.price), oneLine(plan.period)].filter(Boolean).join(" ");
      out.push(`- ${oneLine(plan.name)}: ${price}${oneLine(plan.description) ? `. ${oneLine(plan.description)}` : ""}`);
    }
    if (plans.length > 0) out.push("");
  }

  const setup = agentSetup(c);
  if (setup) {
    out.push("## Use with AI agents", "");
    if (setup.mcpUrl) out.push(link("MCP server", setup.mcpUrl, `streamable HTTP. Claude Code: \`${setup.claudeCode}\``));
    if (setup.openapiUrl) out.push(link("OpenAPI spec", setup.openapiUrl));
    if (setup.docsUrl) out.push(link("API docs", setup.docsUrl));
    out.push("");
  }

  if (opts.full) {
    const section = (title: string, blocks: { title: string; body: string }[]) => {
      if (blocks.length === 0) return;
      out.push(`## ${title}`, "");
      for (const b of blocks) out.push(`- ${oneLine(b.title)}: ${oneLine(b.body)}`);
      out.push("");
    };
    section("Features", (c.features ?? []).filter((f) => trim(f.title)));
    section("Who it is for", (c.audience ?? []).filter((f) => trim(f.title)));
    section("Use cases", useCases(c));
    section("How it works", (c.steps ?? []).filter((f) => trim(f.title)));
    const alts = alternatives(c);
    if (alts.length > 0) {
      out.push("## Compared with alternatives", "");
      for (const a of alts) {
        out.push(`### ${name} or ${oneLine(a.name)}?`, "", oneLine(a.summary));
        if (oneLine(a.chooseUs)) out.push(`Pick ${name} when ${lowerFirst(oneLine(a.chooseUs))}`);
        if (oneLine(a.chooseThem)) out.push(`Pick ${oneLine(a.name)} when ${lowerFirst(oneLine(a.chooseThem))}`);
        out.push("");
      }
    }
    const faq = opts.faq ?? c.faq ?? [];
    if (faq.length > 0) {
      out.push("## Questions and answers", "");
      for (const f of faq) out.push(`### ${oneLine(f.question)}`, "", oneLine(f.answer), "");
    }
    if (setup) out.push("## Setup prompt for an AI agent", "", setup.prompt, "");
  } else {
    out.push("## Optional", "", link("Full text for AI assistants", withBase(base, "/llms-full.txt")), "");
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}
