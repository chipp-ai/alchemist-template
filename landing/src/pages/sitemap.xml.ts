// /sitemap.xml with lastmod = the site's Updated date. Sitemap URLs must be
// absolute, so the file lists pages only when site.json has a `url`.
// In app-first mode ("homepage": "app") the marketing pages are not served,
// so only "/" is listed (sitemapPages in lib/pages.ts). Composed pages and
// blog posts are listed with their own dates; noindex pages are left out
// (sitePages in lib/content.ts).
import { absoluteUrl, site, sitemapPages } from "../lib/site";
import { sitePages } from "../lib/content";

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function GET(): Response {
  const urls = site.url
    ? sitemapPages(site.homepage, sitePages()).map((p) =>
      `  <url>\n    <loc>${escapeXml(absoluteUrl(p.path))}</loc>\n    <lastmod>${p.lastmod ?? site.updatedAt}</lastmod>\n  </url>`
    ).join("\n")
    : "";
  const body = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}${
    urls ? "\n" : ""
  }</urlset>\n`;
  return new Response(body, { headers: { "Content-Type": "application/xml; charset=utf-8" } });
}
