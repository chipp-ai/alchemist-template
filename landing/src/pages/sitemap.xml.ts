// /sitemap.xml with lastmod = the site's Updated date. Sitemap URLs must be
// absolute, so the file lists pages only when site.json has a `url`.
import { PAGES, absoluteUrl, site } from "../lib/site";

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function GET(): Response {
  const urls = site.url
    ? PAGES.map((p) =>
      `  <url>\n    <loc>${escapeXml(absoluteUrl(p.path))}</loc>\n    <lastmod>${site.updatedAt}</lastmod>\n  </url>`
    ).join("\n")
    : "";
  const body = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}${
    urls ? "\n" : ""
  }</urlset>\n`;
  return new Response(body, { headers: { "Content-Type": "application/xml; charset=utf-8" } });
}
