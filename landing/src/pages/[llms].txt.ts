// /llms.txt and /llms-full.txt (llmstxt.org), generated from site.json and
// the built pages (lib/agent-facts.ts llmsTxt). llms.txt is the short index;
// llms-full.txt adds every fact the home page shows, as plain text.
//
// A hand-written or Builder-written file wins: when landing/public/llms.txt
// (the Builder's SEO settings write it) or public/llms-full.txt exists, that
// file is served and this route does not build it.
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { llmsTxt, type LlmsPage } from "../lib/agent-facts";
import { composedPageAt, sitePages } from "../lib/content";
import { pageFaq } from "../lib/page-ld";
import { homeFaq, site, sitemapPages } from "../lib/site";

const FILES = ["llms", "llms-full"] as const;

export function getStaticPaths() {
  return FILES
    .filter((name) => !existsSync(resolve(process.cwd(), "public", `${name}.txt`)))
    .map((name) => ({ params: { llms: name } }));
}

/** One line per page: the classic pages describe themselves from site.json. */
function pages(): LlmsPage[] {
  const classic: Record<string, string> = {
    "/": site.description,
    "/pricing/": site.pricing.answer,
    "/about/": site.about.answer,
  };
  return sitemapPages(site.homepage, sitePages()).map((p) => ({
    path: p.path,
    label: p.label,
    description: composedPageAt(p.path)?.seo?.description ?? classic[p.path],
  }));
}

export function GET({ params }: { params: { llms: string } }): Response {
  // The FAQ the home page shows: a composed "/" page's own, else site.json's.
  const home = composedPageAt("/");
  const faq = home ? pageFaq(home) : homeFaq();
  const body = llmsTxt(site, pages(), { full: params.llms === "llms-full", faq });
  return new Response(body, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
}
