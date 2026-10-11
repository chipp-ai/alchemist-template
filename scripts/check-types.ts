/**
 * Type-check this project with the native TypeScript 7 compiler.
 *
 *   deno run --allow-read --allow-write --allow-run --allow-env --allow-sys \
 *     scripts/check-types.ts [file-or-dir ...]          (default: main.ts)
 *
 * WHY: `deno check` runs the JavaScript TypeScript compiler inside V8. The
 * native Go port checks the same graph several times faster with the same
 * diagnostics. Deno 2.9 ignores `--unstable-tsgo`, so `scripts/lib/tsgo-check.ts`
 * turns `deno info --json` into a plain tsconfig the native compiler reads.
 * That file is copied from chipp-deno (scripts/lib/tsgo-check.ts); keep the
 * two identical, and change it there first.
 *
 * Exit codes: 0 clean, 1 type errors (or a missing local module), 2 could
 * not check (including a remote module that failed to download).
 *
 * FALLBACK: when the native engine cannot give a verdict (no write
 * permission, too little memory, the compiler cannot be fetched, a config
 * error in the generated project), this runs `deno check` on the same
 * arguments instead, so a check never silently passes. `CHECK_ENGINE=deno`
 * forces that path.
 */
import {
  type DenoInfo,
  denoInfoGraph,
  formatInfoModuleErrors,
  runTsgoCheck,
} from "./lib/tsgo-check.ts";

const TAG = "[check-types]";

interface Run {
  code: number;
  signal: string | null;
  stdout: string;
  stderr: string;
}

async function run(program: string, args: string[]): Promise<Run> {
  const out = await new Deno.Command(program, { args, stdout: "piped", stderr: "piped" }).output();
  return {
    code: out.code,
    signal: out.signal ?? null,
    stdout: new TextDecoder().decode(out.stdout),
    stderr: new TextDecoder().decode(out.stderr),
  };
}

/** Same expansion `deno check <dir>` does: every .ts/.tsx/.mts under it. */
function expandEntries(args: string[]): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of Deno.readDirSync(dir)) {
      const p = `${dir.replace(/\/$/, "")}/${e.name}`;
      if (e.isDirectory) {
        if (e.name !== "node_modules" && !e.name.startsWith(".")) walk(p);
      } else if (/\.(m?ts|tsx)$/.test(e.name) && !e.name.endsWith(".d.ts")) {
        out.push(p);
      }
    }
  };
  for (const a of args) {
    if (Deno.statSync(a).isDirectory) walk(a);
    else out.push(a);
  }
  return out;
}

/** "./x.ts" / "../x.ts" / "/abs.ts" stay as they are; anything else (including
 * a dot-directory such as ".scratch/x.ts") gets "./" so it is not read as a
 * bare specifier. */
export function toRelativeSpecifier(f: string): string {
  return f.startsWith("./") || f.startsWith("../") || f.startsWith("/") ? f : `./${f}`;
}

function availableMb(): number {
  try {
    const m = Deno.systemMemoryInfo();
    return (m.available || m.free) / 1024 / 1024;
  } catch {
    return 0;
  }
}

async function denoCheck(args: string[], why: string): Promise<never> {
  console.warn(`${TAG} ${why} -- running deno check`);
  const status = await new Deno.Command("deno", { args: ["check", ...args] }).spawn().status;
  Deno.exit(status.code === 0 ? 0 : 1);
}

/** Oldest Deno whose `deno info --json` the generator was verified against. */
const MIN_DENO = [2, 9, 0];

/** True when `version` ("2.9.7") is at least `min`. */
export function denoAtLeast(version: string, min: readonly number[]): boolean {
  const v = version.split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < min.length; i++) {
    if ((v[i] ?? 0) !== min[i]) return (v[i] ?? 0) > min[i];
  }
  return true;
}

const args = Deno.args.length > 0 ? Deno.args : ["main.ts"];
if ((Deno.env.get("CHECK_ENGINE") ?? "").toLowerCase() === "deno") {
  await denoCheck(args, "CHECK_ENGINE=deno");
}
if (!denoAtLeast(Deno.version.deno, MIN_DENO)) {
  // Projects that still pin an older Deno (many pin 2.3.1 in CI) keep the
  // exact check they had: the graph format was only verified on 2.9.
  await denoCheck(args, `Deno ${Deno.version.deno} is older than ${MIN_DENO.join(".")}`);
}

// One `deno info` over a temporary entry that imports every file, so the
// graph is resolved once however many files are named.
const files = expandEntries(args);
const entry = await Deno.makeTempFile({ dir: ".", prefix: ".check-types-entry-", suffix: ".ts" });
let info: DenoInfo;
try {
  await Deno.writeTextFile(
    entry,
    files.map((f) => `import ${JSON.stringify(toRelativeSpecifier(f))};`).join("\n") +
      "\n",
  );
  // `deno info` exits 0 when a module fails to load, and checking without it
  // turns its exports into `any` (spurious errors, or a silent pass). See
  // `infoModuleErrors` in lib/tsgo-check.ts. A download is retried; an
  // incomplete graph never gets a verdict.
  const graph = await denoInfoGraph(run, ["info", "--json", entry], {
    log: (m) => console.warn(`${TAG} ${m}`),
  });
  if (graph.kind === "command-failed") {
    console.error(`${TAG} deno info failed ${graph.attempts} time(s):\n${graph.stderr}`);
    Deno.exit(2);
  }
  if (graph.kind === "parse-failed") {
    console.error(`${TAG} could not parse deno info output: ${graph.message}\n${graph.stderr}`);
    Deno.exit(2);
  }
  if (graph.kind === "module-errors") {
    const list = formatInfoModuleErrors(graph.errors);
    if (graph.localOnly) {
      // A missing local file is an error in the code; deno check fails on it too.
      console.error(`${TAG} ${graph.errors.length} local module(s) could not be loaded:\n${list}`);
      Deno.exit(1);
    }
    console.error(
      `${TAG} ${graph.errors.length} module(s) could not be loaded after ${graph.attempts} attempt(s); ` +
        `refusing to type-check an incomplete graph:\n${list}`,
    );
    Deno.exit(2);
  }
  info = graph.info;
} finally {
  await Deno.remove(entry).catch(() => {});
}
// The temporary entry is not part of the project.
const entryUrl = `file://${Deno.realPathSync(".")}/${entry.replace(/^\.\//, "")}`;
info.modules = (info.modules ?? []).filter((m) => m.specifier !== entryUrl);
const cwdPrefix = `file://${Deno.realPathSync(".")}/`;
const localCount = (info.modules ?? []).filter((m) => m.specifier.startsWith(cwdPrefix)).length;

const verdict = await runTsgoCheck({
  infos: [info],
  localFileCount: localCount,
  availableMb: availableMb(),
  run,
  log: (m) => console.log(`${TAG} ${m}`),
});
if (verdict.kind === "fallback") await denoCheck(args, `tsgo engine not used (${verdict.reason})`);
if (verdict.kind === "type-errors") {
  for (const d of verdict.diagnostics) console.error(d.text);
  console.error(
    `\n${TAG} ${verdict.diagnostics.length} type error(s) in ${verdict.files.length} file(s) (${verdict.seconds}s)`,
  );
  Deno.exit(1);
}
if (verdict.kind === "ok") {
  console.log(`${TAG} ok: ${verdict.localFiles} files in ${verdict.seconds}s`);
}
Deno.exit(0);
