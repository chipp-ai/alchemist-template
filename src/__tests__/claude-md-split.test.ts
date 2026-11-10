/**
 * scripts/apply-claude-md-split-to-clones.ts: splits an existing project's
 * CLAUDE.md into the index plus docs/conventions files, keeping every line
 * of the project's own text (2026-11-10).
 */
import { assert, assertEquals } from "@std/assert";
import {
  GUIDANCE_TEST_TOPICS,
  parseSections,
  repointGuidanceTest,
  SMALL_SECTION_CHARS,
  splitClaudeMd,
} from "../../scripts/apply-claude-md-split-to-clones.ts";

const root = new URL("../../", import.meta.url);
const templateIndex = await Deno.readTextFile(new URL("CLAUDE.md", root));
const long = (word: string) =>
  `${word} `.repeat(Math.ceil(SMALL_SECTION_CHARS / (word.length + 1)) + 10).trim();

const project = [
  "# Acme Tracker",
  "",
  "Tracks things.",
  "",
  "## Writing style",
  "Short sentences.",
  "## Critical Rules",
  "- Never delete a tracker row.",
  "## Tiny project note",
  "Keep me in the index.",
  "## API Conventions",
  "Routes are thin.",
  "```md",
  "## Not a heading (inside a fence)",
  "```",
  "- Project rule: every route logs its tenant.",
  "## Frontend Conventions",
  long("frontend"),
  "## Self-Improvement Loop (Non-Negotiable)",
  "After ANY correction, update this CLAUDE.md.",
  "## Warehouse sync",
  long("warehouse"),
  "## When to use",
  "Short note that belongs to the sync.",
].join("\n");

Deno.test("parseSections ignores headings inside code fences", () => {
  const { pre, sections } = parseSections(project);
  assertEquals(pre.trim(), "# Acme Tracker\n\nTracks things.");
  assert(!sections.some((s) => s.heading.startsWith("Not a heading")));
});

Deno.test("the split keeps hard rules in the index and moves topics with the project's own text", () => {
  const result = splitClaudeMd(project, templateIndex)!;
  assert(result);
  assert(
    result.index.includes("- Never delete a tracker row."),
    "project hard rules stay in the index",
  );
  assert(result.index.includes("## How this file works"));
  assert(result.index.includes("Keep me in the index."), "a small project-only section stays");
  assert(
    !result.index.includes("Self-Improvement Loop"),
    "the append-to-CLAUDE.md rule is dropped",
  );
  assertEquals(result.dropped, ["Self-Improvement Loop (Non-Negotiable)"]);
  const api = result.topics.get("api")!.body;
  assert(
    api.includes("- Project rule: every route logs its tenant."),
    "the project's additions move with the section",
  );
  assert(api.includes("## Not a heading (inside a fence)"));
  assert(result.topics.get("frontend")!.body.includes("frontend frontend"));
  const sync = result.topics.get("warehouse-sync")!.body;
  assert(
    sync.includes("Short note that belongs to the sync."),
    "a short section after a project topic joins it",
  );
  assert(result.index.includes("| `api.md` |") && result.index.includes("| `warehouse-sync.md` |"));
  assert(
    !result.index.includes("| `redis.md` |"),
    "the index lists only the topic files the project has",
  );
});

Deno.test("a split project is left alone", () => {
  assertEquals(splitClaudeMd(templateIndex, templateIndex), null);
});

Deno.test("the template's own guidance tests are already repointed", async () => {
  for (const [path, topics] of Object.entries(GUIDANCE_TEST_TOPICS)) {
    const source = await Deno.readTextFile(new URL(path, root));
    assertEquals(
      repointGuidanceTest(source, topics),
      null,
      `${path} already reads the index plus its topics`,
    );
    for (const t of topics) {
      assert(source.includes(`../../docs/conventions/${t}.md`), `${path} reads ${t}.md`);
    }
  }
});

Deno.test("repointGuidanceTest rewrites a hub read into the index plus topic files", () => {
  const before = [
    'const read = async (rel: string) => (await Deno.readTextFile(new URL(rel, import.meta.url))).replace(/\\s+/g, " ");',
    'Deno.test("x", async () => {',
    '  const hub = await read("../../CLAUDE.md");',
    "});",
  ].join("\n");
  const after = repointGuidanceTest(before, ["redis"])!;
  assert(after.includes('await readGuide("../../docs/conventions/redis.md")'));
  assert(after.includes("const readGuide = async"));
  assertEquals(repointGuidanceTest(after, ["redis"]), null);
});
