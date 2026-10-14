/**
 * Chat with AI is the embedded Chipp agent (CLAUDE.md, "Chat with AI").
 *
 * Builds kept recreating a chat backend: a provider SDK, a call to a
 * provider's API host, a provider key, or a chat route. This fails the build
 * on any of them in app code. The LLM proxy client (src/services/llm/) and
 * the embedded agent's own files are the only exceptions.
 *
 * Run: deno test --no-check --allow-read src/__tests__/no-custom-ai-chat.test.ts
 */

import { assertEquals } from "@std/assert";

const ROOTS = ["src", "web/src"];
const EXEMPT = [
  "src/services/llm/",
  "src/config/llm.ts",
  "src/services/embedded-agent/",
  "web/src/lib/embedded-agent/",
  "src/__tests__/",
  "web/src/__tests__/",
];

const RULES: Array<{ why: string; pattern: RegExp }> = [
  {
    why: "imports an AI provider SDK (use the embedded Chipp agent, or llmMessages for a one-shot task)",
    pattern: /from\s+["'](?:npm:)?(?:openai|@anthropic-ai\/sdk|@google\/genai|@google\/generative-ai|@ai-sdk\/[\w-]+|ai|langchain|@langchain\/[\w-]+)(?:@[^"']*)?["']/,
  },
  {
    why: "calls an AI provider's API directly",
    pattern: /api\.openai\.com|api\.anthropic\.com|generativelanguage\.googleapis\.com/,
  },
  { why: "reads an AI provider key", pattern: /\b(?:OPENAI_API_KEY|ANTHROPIC_API_KEY|GEMINI_API_KEY)\b/ },
  {
    why: "adds a chat route (chat is the embedded Chipp agent)",
    pattern: /["'`]\/api\/(?:ai[-/])?(?:chat|conversations?)(?:["'`/?])/,
  },
];

async function* files(dir: string): AsyncGenerator<string> {
  let entries: Deno.DirEntry[];
  try {
    entries = [];
    for await (const e of Deno.readDir(dir)) entries.push(e);
  } catch {
    return;
  }
  for (const e of entries) {
    const path = `${dir}/${e.name}`;
    if (e.isDirectory) {
      if (e.name === "node_modules" || e.name.startsWith(".")) continue;
      yield* files(path);
    } else if (/\.(ts|tsx|js|svelte)$/.test(e.name)) {
      yield path;
    }
  }
}

Deno.test("no custom AI chat: app code uses the embedded Chipp agent", async () => {
  const hits: string[] = [];
  for (const root of ROOTS) {
    for await (const path of files(root)) {
      if (EXEMPT.some((p) => path.startsWith(p))) continue;
      const lines = (await Deno.readTextFile(path)).split("\n");
      lines.forEach((line, i) => {
        for (const rule of RULES) {
          if (rule.pattern.test(line)) hits.push(`${path}:${i + 1} ${rule.why}`);
        }
      });
    }
  }
  assertEquals(hits, [], "See CLAUDE.md, \"Chat with AI: it is the embedded Chipp agent\".");
});
