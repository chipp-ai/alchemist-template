/**
 * JSON-LD for composed pages, the blog list and blog posts. The classic
 * pages keep `jsonLd` in lib/site.ts.
 *
 * The first dated node is this page's own (WebPage or BlogPosting), with
 * the same dates the page shows, so the AEO date rule holds. FAQPage comes
 * only from the page's faq sections, word for word. JSON-LD carried over
 * from the old site (seo.jsonLd) is printed after it, minus any FAQPage:
 * a FAQ the reader cannot see on the page is not allowed.
 */
import type { BlogPost, ComposedPage, FaqSection } from "./composed";
import { absoluteUrl, site } from "./site";

function organization(): Record<string, unknown> {
  const org: Record<string, unknown> = { "@type": "Organization", "@id": "#organization", name: site.name };
  if (site.url) org.url = site.url;
  return org;
}

function faqNode(items: { question: string; answer: string }[]): object | null {
  if (items.length === 0) return null;
  return {
    "@type": "FAQPage",
    mainEntity: items.map((f) => ({
      "@type": "Question",
      name: f.question,
      acceptedAnswer: { "@type": "Answer", text: f.answer },
    })),
  };
}

/** The FAQ items a composed page shows. */
export function pageFaq(page: ComposedPage): { question: string; answer: string }[] {
  return page.sections.filter((s): s is FaqSection => s.type === "faq").flatMap((s) => s.items);
}

/** The graph for a composed page or the blog list. */
export function composedPageLd(input: {
  path: string;
  title: string;
  description: string;
  published: string;
  updated: string;
  faq?: { question: string; answer: string }[];
  kind?: "WebPage" | "CollectionPage";
}): object {
  const page: Record<string, unknown> = {
    "@type": input.kind ?? "WebPage",
    name: input.title,
    datePublished: input.published,
    dateModified: input.updated,
    publisher: { "@id": "#organization" },
  };
  if (input.description) page.description = input.description;
  if (site.url) page.url = absoluteUrl(input.path);
  const graph: object[] = [page, organization()];
  const faq = faqNode(input.faq ?? []);
  if (faq) graph.push(faq);
  return { "@context": "https://schema.org", "@graph": graph };
}

/** The graph for one blog post. */
export function postLd(post: BlogPost): object {
  const article: Record<string, unknown> = {
    "@type": "BlogPosting",
    headline: post.title,
    datePublished: post.date.slice(0, 10),
    dateModified: (post.updatedAt ?? post.date).slice(0, 10),
    publisher: { "@id": "#organization" },
  };
  if (post.description) article.description = post.description;
  if (post.author) article.author = { "@type": "Person", name: post.author };
  if (post.image?.src) article.image = post.image.src.startsWith("/") ? absoluteUrl(post.image.src) : post.image.src;
  if (site.url) article.url = absoluteUrl(post.path);
  return { "@context": "https://schema.org", "@graph": [article, organization()] };
}

function isFaq(node: unknown): boolean {
  const t = (node as { "@type"?: unknown })?.["@type"];
  return t === "FAQPage" || (Array.isArray(t) && t.includes("FAQPage"));
}

/** The old site's JSON-LD with FAQPage nodes removed (also inside @graph). */
export function carriedLd(jsonLd: unknown[] | undefined): object[] {
  return (jsonLd ?? []).flatMap((item) => {
    if (!item || typeof item !== "object" || isFaq(item)) return [];
    const graph = (item as { "@graph"?: unknown })["@graph"];
    if (Array.isArray(graph)) return [{ ...(item as object), "@graph": graph.filter((n) => !isFaq(n)) }];
    return [item as object];
  });
}
