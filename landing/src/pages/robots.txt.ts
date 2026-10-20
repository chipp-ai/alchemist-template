// /robots.txt. AI search and answer crawlers are welcome so answer engines
// can read and cite this site. Training-only crawlers are blocked. The rules
// follow chipp.ai's own robots.txt, plus meta-webindexer (Meta AI search).
// A Sitemap line needs an absolute URL, so it is added only when site.json
// has a `url`.
import { absoluteUrl, site } from "../lib/site";

const WELCOME = [
  "GPTBot",
  "OAI-SearchBot",
  "ChatGPT-User",
  "OpenAI-User",
  "ClaudeBot",
  "Claude-SearchBot",
  "Claude-User",
  "Anthropic-AI",
  "Google-Extended",
  "Google-CloudVertexBot",
  "GoogleOther",
  "PerplexityBot",
  "Perplexity-User",
  "Applebot-Extended",
  "meta-externalagent",
  "Meta-ExternalAgent",
  "meta-webindexer",
  "Amazonbot",
  "MistralAI-User",
  "cohere-ai",
  "Diffbot",
];

const BLOCKED = ["CCBot", "Bytespider"];

export function GET(): Response {
  const lines = [
    `# ${site.name} - robots.txt`,
    "# AI search and answer crawlers are welcome. Training-only crawlers are blocked.",
    "",
    "User-agent: *",
    "Content-Signal: search=yes,ai-input=yes,ai-train=no",
    "Allow: /",
    "Disallow: /api/",
  ];
  if (site.url) lines.push(`Sitemap: ${absoluteUrl("/sitemap.xml")}`);
  lines.push("", "# AI search and answer crawlers");
  for (const agent of WELCOME) lines.push("", `User-agent: ${agent}`, "Allow: /", "Disallow: /api/");
  lines.push("", "# Training-only crawlers");
  for (const agent of BLOCKED) lines.push("", `User-agent: ${agent}`, "Disallow: /");
  return new Response(lines.join("\n") + "\n", { headers: { "Content-Type": "text/plain; charset=utf-8" } });
}
