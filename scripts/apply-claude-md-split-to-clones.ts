/**
 * Split an existing customer project's CLAUDE.md into a short index plus
 * docs/conventions/<topic>.md files, the shape this template has had since
 * 2026-11-10. Same family as the other scripts/apply-*-to-clones.sh: customer
 * projects do not track this template as a git remote, so an operator runs
 * this against a local clone and reviews the result.
 *
 * Why: every agent loads CLAUDE.md on every model call. Projects copied the
 * template's 160K-character file and agents appended each learning to it, so
 * one project's file reached 331K characters and a one-line Builder message
 * cost about 190K tokens before any work.
 *
 * What it does, per project:
 *   - Splits CLAUDE.md by its `## ` sections (headings inside code fences do
 *     not count). The project's OWN text of every section is kept: a section
 *     the project extended moves with its additions.
 *   - Keeps in the index: the title block, the hard rules ("Critical Rules"),
 *     "Writing style", "Local Dev Ports", "Quick Start", the website note, and
 *     any small project section (under SMALL_SECTION_CHARS) that maps to no
 *     topic. Adds the template's "How this file works", "Commands" and a
 *     "Topics" table that lists only the topic files this project now has.
 *   - Moves every template section to its topic file (TOPIC_RULES) and every
 *     large project-only section to docs/conventions/<slug>.md, with a line
 *     in "Topics". An existing topic file is appended to, never replaced.
 *   - Drops "Self-Improvement Loop", which told agents to append to
 *     CLAUDE.md; the index's own rule replaces it.
 *   - Repoints the template's guidance tests that read CLAUDE.md (for example
 *     src/__tests__/redis-guidance.test.ts) at the index plus the topic file.
 *   - Copies src/__tests__/claude-md-budget.test.ts only when the new index
 *     is under its budget; otherwise it reports the size and leaves the test
 *     out, so CI does not go red.
 *   - A re-run on a split project is a no-op.
 *
 * Usage:
 *   deno run -A scripts/apply-claude-md-split-to-clones.ts <project-dir> [--commit]
 *
 * Without --commit it only writes the files: review `git diff` in the
 * project. With --commit it creates the branch `chore/claude-md-index` in
 * the project and commits there. It never pushes and never touches the
 * project's default branch: an operator reviews the branch, runs the
 * project's tests, and merges it.
 */

export const SPLIT_BRANCH = "chore/claude-md-index";
export const CLAUDE_MD_BUDGET_CHARS = 16_000;
/** A project-only section at least this long gets its own topic file. */
export const SMALL_SECTION_CHARS = 1_500;
const INDEX_MARKER = "## How this file works";

export interface Section {
  heading: string;
  /** The heading line and everything up to the next `## ` heading. */
  text: string;
}

/** `## ` sections, fence-aware. The text before the first heading is `pre`. */
export function parseSections(md: string): { pre: string; sections: Section[] } {
  const lines = md.split("\n");
  const sections: Section[] = [];
  let pre: string[] = [];
  let cur: string[] | null = null;
  let heading = "";
  let fence = false;
  for (const line of lines) {
    if (line.startsWith("```")) fence = !fence;
    if (!fence && line.startsWith("## ")) {
      if (cur) sections.push({ heading, text: cur.join("\n").trimEnd() });
      cur = [line];
      heading = line.slice(3).trim();
      continue;
    }
    if (cur) cur.push(line);
    else pre.push(line);
  }
  if (cur) sections.push({ heading, text: cur.join("\n").trimEnd() });
  pre = pre.join("\n").trimEnd().split("\n");
  return { pre: pre.join("\n"), sections };
}

/** Where each template section goes, by the start of its heading. First match wins. */
export const TOPIC_RULES: ReadonlyArray<{ prefix: string; slug: string; title: string }> = [
  { prefix: "Architecture", slug: "architecture", title: "Architecture" },
  { prefix: "Landing site", slug: "landing-site", title: "Landing site" },
  {
    prefix: "Engineering Preferences",
    slug: "engineering-preferences",
    title: "Engineering preferences",
  },
  {
    prefix: "Convention spokes",
    slug: "rule-spokes",
    title: "Path-scoped rule spokes (.claude/rules/)",
  },
  {
    prefix: "Observability stream",
    slug: "observability",
    title: "Observability and production debugging",
  },
  {
    prefix: "Production debugging",
    slug: "observability",
    title: "Observability and production debugging",
  },
  { prefix: "API Conventions", slug: "api", title: "API conventions" },
  { prefix: "Error Handling", slug: "api", title: "API conventions" },
  { prefix: "Database Conventions", slug: "database", title: "Database conventions" },
  { prefix: "JSONB", slug: "database", title: "Database conventions" },
  { prefix: "Shared Redis", slug: "redis", title: "Shared Redis" },
  { prefix: "Events", slug: "events", title: "Events" },
  { prefix: "Testing", slug: "testing", title: "Testing" },
  { prefix: "Frontend Conventions", slug: "frontend", title: "Frontend conventions" },
  {
    prefix: "Brand identity",
    slug: "brand-and-design",
    title: "Brand identity and the design system",
  },
  {
    prefix: "Design system",
    slug: "brand-and-design",
    title: "Brand identity and the design system",
  },
  { prefix: "Typography", slug: "brand-and-design", title: "Brand identity and the design system" },
  {
    prefix: "Built-in sections",
    slug: "built-in-sections",
    title: "Built-in sections and public demos",
  },
  {
    prefix: "Public demos",
    slug: "built-in-sections",
    title: "Built-in sections and public demos",
  },
  { prefix: "Sign-in codes", slug: "auth", title: "Sign-in codes and social login" },
  { prefix: "Social login", slug: "auth", title: "Sign-in codes and social login" },
  { prefix: "HIPAA", slug: "hipaa", title: "HIPAA mode" },
  { prefix: "Git Workflow", slug: "git", title: "Git workflow" },
  { prefix: "Files:", slug: "files", title: "Files and storage" },
  { prefix: "File storage", slug: "files", title: "Files and storage" },
  { prefix: "Spreadsheet import", slug: "spreadsheet-import", title: "Spreadsheet import" },
  { prefix: "Selling", slug: "payments", title: "Selling things" },
  {
    prefix: "Built-in API and MCP",
    slug: "api-mcp-features",
    title: "Built-in API and MCP features",
  },
  {
    prefix: "Chat with AI",
    slug: "embedded-agent",
    title: "Chat with AI and embedded agent tools",
  },
  {
    prefix: "Embedded agent",
    slug: "embedded-agent",
    title: "Chat with AI and embedded agent tools",
  },
  { prefix: "Inbound email", slug: "email", title: "Email: inbound, outbound, the outbox" },
  { prefix: "Outbound email", slug: "email", title: "Email: inbound, outbound, the outbox" },
  { prefix: "Email", slug: "email", title: "Email: inbound, outbound, the outbox" },
  { prefix: "Newsletters", slug: "newsletters", title: "Newsletters and bulk email" },
  { prefix: "End-user portal", slug: "portal", title: "End-user portal lane" },
  { prefix: "Browser automation", slug: "browser-automation", title: "Browser automation" },
  { prefix: "Verification Checklist", slug: "verification", title: "Verification and evidence" },
  { prefix: "Evidence", slug: "verification", title: "Verification and evidence" },
  {
    prefix: "Agent verification toolkit",
    slug: "verification",
    title: "Verification and evidence",
  },
  { prefix: "Dev affordances", slug: "dev-affordances", title: "Dev affordances" },
  { prefix: "Library version idioms", slug: "library-idioms", title: "Library version idioms" },
  { prefix: "Common Pitfalls", slug: "pitfalls", title: "Common pitfalls" },
  { prefix: "Background work", slug: "background-work", title: "Background work" },
  { prefix: "Chipp Insights", slug: "insights", title: "Chipp Insights" },
];

/** Sections that stay in the index, by the start of their heading. */
const KEEP_PREFIXES = [
  "Writing style",
  "Local Dev Ports",
  "Quick Start",
  "Critical Rules",
  "This project is a website",
];
/** Sections the index's own rule replaces. */
const DROP_PREFIXES = ["Self-Improvement Loop"];

export function slugify(heading: string): string {
  const slug = heading.toLowerCase().replace(/`/g, "").replace(/[^a-z0-9]+/g, "-").replace(
    /^-+|-+$/g,
    "",
  );
  return (slug.split("-").slice(0, 6).join("-") || "project-notes");
}

export interface SplitResult {
  index: string;
  /** Repo-relative path to content, for each topic file to write. */
  topics: Map<string, { title: string; body: string }>;
  /** Index lines for project-only topics. */
  projectRows: string[];
  dropped: string[];
}

/**
 * The pure split. `templateIndex` is this template's CLAUDE.md, the source of
 * the "How this file works", "Commands" and "Topics" sections.
 */
export function splitClaudeMd(project: string, templateIndex: string): SplitResult | null {
  if (project.includes(INDEX_MARKER)) return null;
  const { pre, sections } = parseSections(project);
  const template = parseSections(templateIndex).sections;
  const templateSection = (prefix: string) =>
    template.find((s) => s.heading.startsWith(prefix))?.text ?? "";

  const kept: string[] = [];
  const topics = new Map<string, { title: string; body: string }>();
  const projectRows: string[] = [];
  const dropped: string[] = [];
  const add = (slug: string, title: string, text: string) => {
    const cur = topics.get(slug);
    topics.set(slug, { title: cur?.title ?? title, body: cur ? `${cur.body}\n\n${text}` : text });
  };
  const starts = (heading: string, prefix: string) =>
    heading.toLowerCase().startsWith(prefix.toLowerCase());
  // A large project-only section is one topic, together with the short
  // project-only sections right after it: a recipe or pack often appends a
  // heading followed by short "When to use" / "Common pitfalls" sections.
  let run: Section[] = [];
  const projectSlugs = new Map<string, string>();
  const flushRun = () => {
    if (run.length === 0) return;
    const text = run.map((r) => r.text).join("\n\n");
    if (text.length < SMALL_SECTION_CHARS) {
      kept.push(text);
    } else {
      // The same heading twice (a pack appended twice) is one topic.
      const title = run[0].heading.replace(/`/g, "");
      let slug = projectSlugs.get(title) ?? slugify(run[0].heading);
      if (!projectSlugs.has(title)) {
        const base = TOPIC_RULES.some((r) => r.slug === slug) ? `${slug}-project` : slug;
        slug = base;
        for (let n = 2; topics.has(slug); n++) slug = `${base}-${n}`;
        projectSlugs.set(title, slug);
        projectRows.push(`| \`${slug}.md\` | work on ${title.replace(/\|/g, "/")} |`);
      }
      add(slug, title, text);
    }
    run = [];
  };
  for (const s of sections) {
    if (DROP_PREFIXES.some((p) => starts(s.heading, p))) {
      flushRun();
      dropped.push(s.heading);
      continue;
    }
    if (KEEP_PREFIXES.some((p) => starts(s.heading, p))) {
      flushRun();
      kept.push(s.text);
      continue;
    }
    // Right after a large project topic, a short generic subheading ("Common
    // pitfalls") belongs to that topic, not to the template's file.
    const inProjectTopic = run.length > 0 && run[0].text.length >= SMALL_SECTION_CHARS;
    const rule = inProjectTopic && s.text.length < SMALL_SECTION_CHARS
      ? undefined
      : TOPIC_RULES.find((r) => starts(s.heading, r.prefix));
    if (rule) {
      flushRun();
      add(rule.slug, rule.title, s.text);
      continue;
    }
    // A large section starts its own topic; a small one joins the run before it.
    if (s.text.length >= SMALL_SECTION_CHARS) flushRun();
    run.push(s);
  }
  flushRun();

  // The template's Topics rows for the files this project now has, then the project's own.
  const topicsSection = templateSection("Topics");
  const templateRows = topicsSection.split("\n").filter((l) => /^\| `[a-z0-9-]+\.md` \|/.test(l));
  const rows = templateRows.filter((l) => topics.has(l.match(/^\| `([a-z0-9-]+)\.md`/)![1]));
  const tableHead = "| File (`docs/conventions/`) | Read it when you |\n|---|---|";
  const index = [
    pre.trimEnd(),
    templateSection("How this file works"),
    ...kept,
    templateSection("Commands"),
    `## Topics\n\nRead the file before you work in that area.\n\n${tableHead}\n${
      [...rows, ...projectRows].join("\n")
    }`,
  ].filter((part) => part.trim().length > 0).join("\n\n") + "\n";
  return { index, topics, projectRows, dropped };
}

/** Which topic files each template guidance test reads beside the index (see the template's own tests). */
export const GUIDANCE_TEST_TOPICS: Readonly<Record<string, string[]>> = {
  "src/__tests__/agent-tools-guidance.test.ts": ["embedded-agent"],
  "src/__tests__/files-guidance.test.ts": ["files"],
  "src/__tests__/ux-guidance.test.ts": ["rule-spokes", "verification"],
  "src/__tests__/redis-guidance.test.ts": ["redis"],
  "src/__tests__/events-guidance.test.ts": ["events"],
  "src/__tests__/context-switch-guidance.test.ts": ["frontend", "rule-spokes", "pitfalls"],
  "src/__tests__/agent-capabilities-guidance.test.ts": ["embedded-agent"],
};

const READ_GUIDE_HELPER = `
// CLAUDE.md is a short index since 2026-11-10; each topic lives in
// docs/conventions/<topic>.md. The guidance is the index plus the topic
// files, and the index must list every one of them.
const readGuide = async (...topics: string[]) => {
  const index = await read("../../CLAUDE.md");
  for (const t of topics) {
    const file = t.split("/").pop()!;
    if (!index.includes(\`| \\\`\${file}\\\` |\`)) throw new Error(\`CLAUDE.md must list \${file} in Topics\`);
  }
  return [index, ...(await Promise.all(topics.map((t) => read(t))))].join(" ");
};
`;

/** A guidance test that reads `../../CLAUDE.md` as the hub, repointed. Null when it does not. */
export function repointGuidanceTest(source: string, topics: readonly string[]): string | null {
  const call = 'await read("../../CLAUDE.md")';
  if (!source.includes(call) || source.includes("const readGuide")) return null;
  const start = source.indexOf("const read = async");
  if (start === -1) return null;
  const end = source.indexOf(";\n", start) + 2;
  const files = topics.map((t) => `"../../docs/conventions/${t}.md"`).join(", ");
  const rest = source.slice(end).replaceAll(call, `await readGuide(${files})`);
  return source.slice(0, end) + READ_GUIDE_HELPER + rest;
}

async function readText(path: string): Promise<string | null> {
  try {
    return await Deno.readTextFile(path);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return null;
    throw err;
  }
}

async function git(dir: string, args: string[]): Promise<string> {
  const out = await new Deno.Command("git", { args, cwd: dir, stdout: "piped", stderr: "piped" })
    .output();
  if (!out.success) {
    throw new Error(`git ${args.join(" ")}: ${new TextDecoder().decode(out.stderr).trim()}`);
  }
  return new TextDecoder().decode(out.stdout).trim();
}

async function main(args: string[]): Promise<number> {
  const target = args.find((a) => !a.startsWith("--"));
  const commit = args.includes("--commit");
  if (!target) {
    console.error(
      "usage: deno run -A scripts/apply-claude-md-split-to-clones.ts <project-dir> [--commit]",
    );
    return 2;
  }
  const templateRoot = new URL("../", import.meta.url).pathname;
  const templateIndex = await Deno.readTextFile(`${templateRoot}CLAUDE.md`);
  const project = await readText(`${target}/CLAUDE.md`);
  if (project === null) {
    console.log("  [skip] no CLAUDE.md");
    return 0;
  }
  const result = splitClaudeMd(project, templateIndex);
  if (!result) {
    console.log("  [skip] CLAUDE.md is already an index");
    return 0;
  }
  if (commit) {
    const dirty = await git(target, ["status", "--porcelain"]);
    if (dirty) {
      console.error("  [fail] the project has uncommitted changes; commit or clean them first");
      return 1;
    }
    await git(target, ["checkout", "-b", SPLIT_BRANCH]);
  }
  await Deno.mkdir(`${target}/docs/conventions`, { recursive: true });
  const written: string[] = ["CLAUDE.md"];
  for (const [slug, { title, body }] of result.topics) {
    const path = `docs/conventions/${slug}.md`;
    const existing = await readText(`${target}/${path}`);
    const text = existing === null
      ? `# ${title}\n\n${body}\n`
      : `${existing.trimEnd()}\n\n${body}\n`;
    await Deno.writeTextFile(`${target}/${path}`, text);
    written.push(path);
    console.log(`  [ok]   ${path} (${text.length} chars${existing === null ? "" : ", appended"})`);
  }
  await Deno.writeTextFile(`${target}/CLAUDE.md`, result.index);
  console.log(`  [ok]   CLAUDE.md: ${project.length} -> ${result.index.length} chars`);
  for (const heading of result.dropped) {
    console.log(`  [ok]   dropped "${heading}" (the index's rule replaces it)`);
  }
  for (const row of result.projectRows) console.log(`  [ok]   project topic ${row}`);

  for (const [path, topics] of Object.entries(GUIDANCE_TEST_TOPICS)) {
    const source = await readText(`${target}/${path}`);
    if (source === null) continue;
    const next = repointGuidanceTest(source, topics.filter((t) => result.topics.has(t)));
    if (next === null) continue;
    await Deno.writeTextFile(`${target}/${path}`, next);
    written.push(path);
    console.log(`  [ok]   ${path} reads the index plus its topic files`);
  }
  const budgetTest = "src/__tests__/claude-md-budget.test.ts";
  if (result.index.length <= CLAUDE_MD_BUDGET_CHARS) {
    await Deno.copyFile(`${templateRoot}${budgetTest}`, `${target}/${budgetTest}`);
    written.push(budgetTest);
    console.log(`  [ok]   ${budgetTest}`);
  } else {
    console.warn(
      `  [warn] the index is ${result.index.length} chars, over the ${CLAUDE_MD_BUDGET_CHARS} budget; ` +
        `${budgetTest} not added. Move project rules out of the kept sections, then add it.`,
    );
  }
  if (commit) {
    await git(target, ["add", ...written]);
    await git(target, [
      "commit",
      "-m",
      "docs: CLAUDE.md becomes a short index; topics move to docs/conventions/\n\n" +
      `CLAUDE.md ${project.length} -> ${result.index.length} characters. Applied by ` +
      "alchemist-template scripts/apply-claude-md-split-to-clones.ts. Review before merging.",
    ]);
    console.log(`  [ok]   committed on ${SPLIT_BRANCH} (not pushed)`);
  } else {
    console.log("  Review `git diff`, run the project's tests, then commit.");
  }
  return 0;
}

if (import.meta.main) Deno.exit(await main(Deno.args));
