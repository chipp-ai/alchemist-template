/**
 * Type-check a Deno module graph with the native TypeScript 7 compiler
 * ("tsgo"), the default engine behind `scripts/check-project.ts`.
 *
 * WHY
 * ---
 * `deno check` runs the JavaScript TypeScript compiler inside V8. On this
 * repo's `main.ts` graph (~3,700 local files) that took 112s and 6.3GB.
 * The Go port of the compiler checks the same graph in ~6-7s with the SAME
 * diagnostics (measured 2026-10-08: two planted errors produced 854
 * file:line:code diagnostics from each engine, identical sets).
 *
 * Deno 2.9.7 parses `--unstable-tsgo` but ignores it: the tsgo fork was
 * removed upstream (denoland/deno#33133) and the stock-tsc tsconfig
 * generator (`cli/tools/installer/npm_compat.rs`) is unwired. So this file
 * does what that generator would: it turns `deno info --json` into a plain
 * tsconfig that stock TypeScript understands.
 *
 * HOW
 * ---
 * 1. `deno info --json <entry>` gives every module, every written import
 *    specifier with what it resolved to, and every npm package with its
 *    unpacked path in Deno's npm cache.
 * 2. npm packages become a pnpm-style tree of SYMLINKS into that cache
 *    (`npm/<id>/node_modules/<name>`, siblings = its dependencies), read
 *    with `preserveSymlinks` so bare imports inside a package resolve to
 *    the version Deno resolved. Nothing is downloaded.
 * 3. Remote modules (jsr:, https:) are copied to `remote/<host>/<path>` with
 *    `// @ts-nocheck`, because Deno does not report errors in remote code.
 * 4. Every non-relative written specifier gets an exact `paths` entry that
 *    points at the file Deno resolved it to.
 * 5. Diagnostics Deno suppresses (`DENO_IGNORED_DIAGNOSTIC_CODES`) and
 *    diagnostics outside the repo are dropped, as Deno does.
 *
 * KNOWN GAP: Deno's TypeScript fork drops the `@types/node` copies of
 * globals Deno already declares (`TYPES_NODE_IGNORABLE_NAMES` in
 * cli/tsc/mod.rs). Stock TypeScript merges them instead. No diagnostic
 * differed on this repo, and nightly CI runs BOTH engines so a divergence
 * shows up as one engine failing while the other passes.
 */

/** Pinned native compiler. Bump together with a parity run of both engines
 * (`CHECK_ENGINE=tsgo` and `CHECK_ENGINE=deno` on `main.ts`). */
export const TS_NATIVE_VERSION = "7.0.2";
/** `@types/node` loaded for `node:` imports (Deno bundles its own copy). */
export const TYPES_NODE_VERSION = "22.20.5";

/** Diagnostic codes Deno never reports. Copied from
 * `IGNORED_DIAGNOSTIC_CODES` in denoland/deno `cli/tsc/mod.rs` at v2.9.7;
 * see that file for the reason behind each code. */
export const DENO_IGNORED_DIAGNOSTIC_CODES: ReadonlySet<number> = new Set([
  1452, 1471, 1479, 1543, 2306, 2688, 2792, 2307, 2834, 2835, 2882, 5009, 5055,
  5070, 6200, 7016, 18060,
]);

// ---------------------------------------------------------------------------
// `deno info --json` shape (only the fields read here)
// ---------------------------------------------------------------------------

export interface InfoResolution {
  specifier?: string;
}

export interface InfoDependency {
  specifier: string;
  code?: InfoResolution;
  type?: InfoResolution;
}

export interface InfoModule {
  specifier: string;
  kind?: string;
  local?: string;
  mediaType?: string;
  npmPackage?: string;
  dependencies?: InfoDependency[];
  typesDependency?: { specifier?: string; dependency?: InfoResolution };
}

export interface InfoNpmPackage {
  name: string;
  version: string;
  dependencies?: string[];
  localPath?: string;
}

export interface DenoInfo {
  modules?: InfoModule[];
  redirects?: Record<string, string>;
  npmPackages?: Record<string, InfoNpmPackage>;
}

/** Union several `deno info` documents (one per entry point). */
export function mergeInfos(infos: DenoInfo[]): DenoInfo {
  const modules = new Map<string, InfoModule>();
  const redirects: Record<string, string> = {};
  const npmPackages: Record<string, InfoNpmPackage> = {};
  for (const info of infos) {
    for (const m of info.modules ?? []) if (!modules.has(m.specifier)) modules.set(m.specifier, m);
    Object.assign(redirects, info.redirects ?? {});
    Object.assign(npmPackages, info.npmPackages ?? {});
  }
  return { modules: [...modules.values()], redirects, npmPackages };
}

// ---------------------------------------------------------------------------
// npm package entry resolution (package.json "exports" / "types")
// ---------------------------------------------------------------------------

const EXPORT_CONDITIONS = ["types", "deno", "import", "module", "default", "node", "require"];

/** Every target a conditional export offers, in condition priority order. */
function allExportTargets(target: unknown, out: string[] = []): string[] {
  if (typeof target === "string") {
    if (!out.includes(target)) out.push(target);
  } else if (Array.isArray(target)) {
    for (const t of target) allExportTargets(t, out);
  } else if (target && typeof target === "object") {
    const obj = target as Record<string, unknown>;
    for (const c of EXPORT_CONDITIONS) if (c in obj) allExportTargets(obj[c], out);
  }
  return out;
}

/**
 * All candidate paths (relative to the package dir) for `subpath`, best
 * first. The caller takes the first one that resolves to a real file: a
 * `types` pattern such as `"./*": { "types": "./dist/esm/*.d.ts" }` applied
 * to `server/mcp.js` names `mcp.js.d.ts`, which does not exist, and
 * TypeScript then falls through to the `import` target (2026-10-08,
 * @modelcontextprotocol/sdk in alchemist-template).
 */
export function resolvePackageEntryCandidates(
  pkgJson: Record<string, unknown>,
  subpath: string,
): string[] {
  const key = subpath ? `./${subpath}` : ".";
  const out: string[] = [];
  let exp = pkgJson.exports;
  if (exp !== undefined && exp !== null) {
    if (
      typeof exp === "string" || Array.isArray(exp) ||
      (typeof exp === "object" && !Object.keys(exp as object).some((k) => k.startsWith(".")))
    ) {
      exp = { ".": exp };
    }
    const map = exp as Record<string, unknown>;
    if (key in map) allExportTargets(map[key], out);
    for (const [pattern, target] of Object.entries(map)) {
      const star = pattern.indexOf("*");
      if (star < 0) continue;
      const pre = pattern.slice(0, star);
      const post = pattern.slice(star + 1);
      if (key.startsWith(pre) && key.endsWith(post) && key.length >= pre.length + post.length) {
        const matched = key.slice(pre.length, key.length - post.length);
        for (const t of allExportTargets(target)) {
          const r = t.replaceAll("*", matched);
          if (!out.includes(r)) out.push(r);
        }
      }
    }
  }
  if (!subpath) {
    const t = pkgJson.types ?? pkgJson.typings;
    if (typeof t === "string" && !out.includes(t)) out.push(t);
  }
  return out;
}

/** The best candidate from {@link resolvePackageEntryCandidates}, or null
 * when the package does not say (the caller falls back to the subpath). */
export function resolvePackageEntry(
  pkgJson: Record<string, unknown>,
  subpath: string,
): string | null {
  return resolvePackageEntryCandidates(pkgJson, subpath)[0] ?? null;
}

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

export interface TscDiagnostic {
  /** Path exactly as tsc printed it (relative to tsc's cwd), or null for a
   * global diagnostic (config errors). */
  file: string | null;
  line: number;
  column: number;
  code: number;
  /** The full diagnostic text including continuation lines. */
  text: string;
}

const DIAG_RE = /^(.+?)\((\d+),(\d+)\): error TS(\d+): /;
const GLOBAL_DIAG_RE = /^error TS(\d+): /;

/** Parse `tsc --pretty false` output. Continuation lines (indented) are
 * appended to the diagnostic above them. */
export function parseTscDiagnostics(output: string): TscDiagnostic[] {
  const diags: TscDiagnostic[] = [];
  for (const line of output.split("\n")) {
    const m = DIAG_RE.exec(line);
    if (m) {
      diags.push({ file: m[1], line: +m[2], column: +m[3], code: +m[4], text: line });
      continue;
    }
    const g = GLOBAL_DIAG_RE.exec(line);
    if (g) {
      diags.push({ file: null, line: 0, column: 0, code: +g[1], text: line });
      continue;
    }
    if (diags.length > 0 && /^\s+\S/.test(line)) diags[diags.length - 1].text += `\n${line}`;
  }
  return diags;
}

/** Keep the diagnostics Deno would report: not an ignored code, and (for
 * file diagnostics) inside the repo but outside the generated project. */
export function filterLikeDeno(
  diags: TscDiagnostic[],
  opts: { repoRoot: string; generatedRoot: string; resolve: (file: string) => string },
): TscDiagnostic[] {
  return diags.filter((d) => {
    if (DENO_IGNORED_DIAGNOSTIC_CODES.has(d.code)) return false;
    if (d.file === null) return true;
    const abs = opts.resolve(d.file);
    if (abs.startsWith(opts.generatedRoot + "/")) return false;
    return abs.startsWith(opts.repoRoot + "/");
  });
}

// ---------------------------------------------------------------------------
// Memory plan
// ---------------------------------------------------------------------------

export type TsgoMemoryPlan =
  | { kind: "parallel"; estimateMb: number }
  | { kind: "single-threaded"; estimateMb: number }
  | { kind: "insufficient"; estimateMb: number };

/**
 * Peak RSS measured on the 3,709-file `main.ts` graph (2026-10-08): 5.6GB
 * with the default 4 checkers, 4.6GB `--singleThreaded`. `GOMEMLIMIT` does
 * not lower it (the live heap is that big). These linear fits reproduce
 * both readings; small graphs are dominated by the fixed term.
 */
export function estimateTsgoPeakMb(localFiles: number, singleThreaded: boolean): number {
  return singleThreaded ? 1000 + localFiles : 1500 + Math.round(localFiles * 1.1);
}

export function planTsgoMemory(localFiles: number, availableMb: number): TsgoMemoryPlan {
  const parallel = estimateTsgoPeakMb(localFiles, false);
  if (availableMb >= parallel) return { kind: "parallel", estimateMb: parallel };
  const single = estimateTsgoPeakMb(localFiles, true);
  if (availableMb >= single) return { kind: "single-threaded", estimateMb: single };
  return { kind: "insufficient", estimateMb: single };
}

// ---------------------------------------------------------------------------
// Project generation
// ---------------------------------------------------------------------------

const MEDIA_EXT: Record<string, string> = {
  Dts: ".d.ts",
  Dmts: ".d.mts",
  Dcts: ".d.cts",
  TypeScript: ".ts",
  Mts: ".mts",
  Cts: ".cts",
  Tsx: ".tsx",
  JavaScript: ".js",
  Mjs: ".mjs",
  Cjs: ".cjs",
  Jsx: ".jsx",
  Json: ".json",
};
const SCRIPT_MEDIA = new Set(["TypeScript", "Mts", "Cts", "Tsx", "JavaScript", "Mjs", "Cjs", "Jsx"]);
const AMBIENT_MODULE_RE = /^\s*declare\s+module\s+['"]([^'"]+)['"]/m;
const TOP_LEVEL_MODULE_SYNTAX_RE = /^(export|import)\s/m;

/** Compiler options Deno reads from deno.json that must not pass through:
 * we supply the libs and type roots ourselves. */
const OWNED_COMPILER_OPTIONS = new Set(["lib", "types", "typeRoots"]);

export interface GenerateOptions {
  info: DenoInfo;
  repoRoot: string;
  outDir: string;
  /** `compilerOptions` from deno.json, passed through except `lib`/`types`. */
  denoCompilerOptions: Record<string, unknown>;
  /** Output of `deno types` (the Deno namespace + web globals). */
  denoTypes: string;
  /** npm package id of `@types/node` inside `info.npmPackages`. */
  typesNodeId: string | null;
}

export interface GeneratedProject {
  tsconfigPath: string;
  localFiles: string[];
  pathCount: number;
}

function exists(p: string): boolean {
  try {
    Deno.statSync(p);
    return true;
  } catch {
    return false;
  }
}

function isFile(p: string): boolean {
  try {
    return Deno.statSync(p).isFile;
  } catch {
    return false;
  }
}

function readJson(p: string): Record<string, unknown> {
  try {
    return JSON.parse(Deno.readTextFileSync(p));
  } catch {
    return {};
  }
}

function dirname(p: string): string {
  const i = p.lastIndexOf("/");
  return i <= 0 ? "/" : p.slice(0, i);
}

function join(...parts: string[]): string {
  return parts.join("/").replace(/\/+/g, "/").replace(/\/\.\//g, "/");
}

function escapeId(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]/g, "+");
}

/** Map a JS file or package dir to the declaration TypeScript would load. */
function declarationFor(p: string): string | null {
  try {
    if (Deno.statSync(p).isDirectory) {
      const pj = readJson(join(p, "package.json"));
      for (const k of ["types", "typings"]) {
        if (typeof pj[k] === "string") return declarationFor(join(p, pj[k] as string));
      }
      if (exists(join(p, "index.d.ts"))) return join(p, "index.d.ts");
      if (typeof pj.main === "string") return declarationFor(join(p, pj.main));
      return null;
    }
  } catch {
    // not a dir; fall through to file handling
  }
  if (/\.(d\.)?[mc]?tsx?$/.test(p) && isFile(p)) return p;
  for (const [js, dts] of [[".mjs", ".d.mts"], [".cjs", ".d.cts"], [".jsx", ".d.ts"], [".js", ".d.ts"]]) {
    if (p.endsWith(js)) {
      const base = p.slice(0, -js.length);
      if (isFile(base + dts)) return base + dts;
      if (isFile(base + ".d.ts")) return base + ".d.ts";
      return null;
    }
  }
  for (const ext of [".d.ts", ".ts", "/index.d.ts"]) if (isFile(p + ext)) return p + ext;
  return null;
}

/** A JS file TypeScript can treat as an untyped module (implicitly `any`;
 * Deno drops the TS7016 that goes with it). */
function javascriptFor(p: string): string | null {
  if (isFile(p)) return p;
  const pj = readJson(join(p, "package.json"));
  for (const c of [pj.main, "index.js"]) {
    if (typeof c !== "string") continue;
    for (const ext of ["", ".js"]) if (isFile(join(p, c) + ext)) return join(p, c) + ext;
  }
  return null;
}

export function generateTsgoProject(opts: GenerateOptions): GeneratedProject {
  const { info, repoRoot, outDir } = opts;
  const modules = new Map((info.modules ?? []).map((m) => [m.specifier, m]));
  const redirects = info.redirects ?? {};
  const npm = info.npmPackages ?? {};
  Deno.mkdirSync(outDir, { recursive: true });

  const follow = (s: string) => {
    for (let i = 0; i < 20 && s in redirects; i++) s = redirects[s];
    return s;
  };

  // npm: pnpm-style symlink tree into Deno's npm cache.
  const pkgDir = (id: string) => join(outDir, "npm", escapeId(id), "node_modules", npm[id].name);
  const link = (target: string, at: string) => {
    if (exists(at)) return;
    Deno.mkdirSync(dirname(at), { recursive: true });
    try {
      Deno.symlinkSync(target, at);
    } catch (err) {
      if (!(err instanceof Deno.errors.AlreadyExists)) throw err;
    }
  };
  for (const [id, pkg] of Object.entries(npm)) {
    if (!pkg.localPath) continue;
    link(pkg.localPath, pkgDir(id));
    for (const dep of pkg.dependencies ?? []) {
      const d = npm[dep];
      if (!d?.localPath) continue;
      link(d.localPath, join(outDir, "npm", escapeId(id), "node_modules", d.name));
    }
  }

  // Remote modules: mirror with their path, add an extension if the URL has none.
  const mirrorPath = (url: string): string => {
    const u = new URL(url);
    let p = u.pathname.replace(/^\/+/, "") || "index";
    const ext = MEDIA_EXT[modules.get(url)?.mediaType ?? ""] ?? "";
    if (ext && !p.endsWith(ext)) p += ext;
    return join(outDir, "remote", u.hostname, p);
  };
  for (const m of modules.values()) {
    if (!m.specifier.startsWith("http") || !m.local) continue;
    const dst = mirrorPath(m.specifier);
    Deno.mkdirSync(dirname(dst), { recursive: true });
    const body = Deno.readFileSync(m.local);
    if (SCRIPT_MEDIA.has(m.mediaType ?? "")) {
      const header = new TextEncoder().encode("// @ts-nocheck\n");
      const out = new Uint8Array(header.length + body.length);
      out.set(header);
      out.set(body, header.length);
      Deno.writeFileSync(dst, out);
    } else {
      Deno.writeFileSync(dst, body);
    }
  }

  const extraFiles: string[] = [];
  let shimCount = 0;
  const writeShim = (text: string) => {
    const p = join(outDir, "shims", `s${++shimCount}.d.ts`);
    Deno.mkdirSync(dirname(p), { recursive: true });
    Deno.writeTextFileSync(p, text);
    return p;
  };

  const UNTYPED = Symbol("untyped");
  const npmCache = new Map<string, string | typeof UNTYPED | null>();
  const npmTarget = (spec: string): string | typeof UNTYPED | null => {
    if (npmCache.has(spec)) return npmCache.get(spec)!;
    let result: string | typeof UNTYPED | null = null;
    const id = modules.get(spec)?.npmPackage;
    const pkg = id ? npm[id] : undefined;
    if (id && pkg?.localPath) {
      // spec = "npm:/<name>@<version>[/<sub>]"
      const afterName = spec.slice("npm:/".length + pkg.name.length);
      const slash = afterName.indexOf("/");
      const sub = slash >= 0 ? afterName.slice(slash + 1) : "";
      const entries = resolvePackageEntryCandidates(readJson(join(pkg.localPath, "package.json")), sub)
        .map((e) => join(pkgDir(id), e));
      entries.push(sub ? join(pkgDir(id), sub) : pkgDir(id));
      let dts: string | null = null;
      for (const e of entries) {
        dts = declarationFor(e);
        if (dts) break;
      }
      const candidate = entries.find((e) => exists(e)) ?? entries[0];
      if (dts === null) {
        result = javascriptFor(candidate) ?? UNTYPED;
      } else {
        const src = Deno.readTextFileSync(dts);
        const ambient = AMBIENT_MODULE_RE.exec(src);
        if (ambient && !TOP_LEVEL_MODULE_SYNTAX_RE.test(src)) {
          // e.g. stripe: `declare module 'stripe' { ... }` with no top-level
          // export. Load the declaration globally and re-export the module.
          extraFiles.push(dts);
          const name = ambient[1];
          result = writeShim(
            `export * from "${name}";\nimport d from "${name}";\nexport default d;\n`,
          );
        } else {
          result = dts;
        }
      }
    }
    npmCache.set(spec, result);
    return result;
  };

  const targetOf = (resolved: string): string | typeof UNTYPED | null => {
    resolved = follow(resolved);
    if (resolved.startsWith("file://")) return decodeURIComponent(resolved.slice("file://".length));
    if (resolved.startsWith("http")) {
      const types = modules.get(resolved)?.typesDependency?.dependency?.specifier;
      return mirrorPath(types ? follow(types) : resolved);
    }
    if (resolved.startsWith("npm:")) return npmTarget(resolved);
    return null;
  };

  const paths: Record<string, string[]> = {};
  const untyped = new Set<string>();
  const localFiles: string[] = [];
  const repoPrefix = `file://${repoRoot}/`;
  for (const m of modules.values()) {
    if (m.specifier.startsWith(repoPrefix)) {
      localFiles.push(decodeURIComponent(m.specifier.slice("file://".length)));
    }
    for (const dep of m.dependencies ?? []) {
      const written = dep.specifier;
      if (written.startsWith(".") || written.startsWith("/") || written.startsWith("node:")) continue;
      const resolved = dep.type?.specifier ?? dep.code?.specifier;
      if (!resolved) continue;
      const target = targetOf(resolved);
      if (target === null) continue;
      if (target === UNTYPED) {
        untyped.add(written);
        continue;
      }
      // First mapping wins. A written specifier that resolves differently in
      // two modules (scoped import maps) only happens inside remote code,
      // which is @ts-nocheck.
      paths[written] ??= [target];
    }
  }
  if (untyped.size > 0) {
    extraFiles.push(writeShim([...untyped].sort().map((w) => `declare module "${w}";\n`).join("")));
  }

  const denoTypesPath = join(outDir, "deno.d.ts");
  Deno.writeTextFileSync(denoTypesPath, opts.denoTypes);
  const typesNode = opts.typesNodeId && npm[opts.typesNodeId]
    ? join(pkgDir(opts.typesNodeId), "index.d.ts")
    : null;

  const passthrough = Object.fromEntries(
    Object.entries(opts.denoCompilerOptions).filter(([k]) => !OWNED_COMPILER_OPTIONS.has(k)),
  );
  const tsconfig = {
    compilerOptions: {
      // Deno's defaults (deno.json can override any of these below).
      target: "esnext",
      jsx: "react",
      strict: true,
      useDefineForClassFields: true,
      esModuleInterop: true,
      isolatedModules: true,
      ...passthrough,
      // Owned by this generator: how modules are found and what is emitted.
      module: "preserve",
      moduleResolution: "bundler",
      moduleDetection: "force",
      lib: ["esnext", "esnext.disposable"],
      types: [],
      typeRoots: [],
      allowImportingTsExtensions: true,
      allowJs: true,
      checkJs: false,
      maxNodeModuleJsDepth: 0,
      resolveJsonModule: true,
      noEmit: true,
      skipLibCheck: true,
      preserveSymlinks: true,
      paths,
    },
    files: [
      denoTypesPath,
      ...(typesNode ? [typesNode] : []),
      ...[...new Set(extraFiles)].sort(),
      ...localFiles.sort(),
    ],
  };
  const tsconfigPath = join(outDir, "tsconfig.json");
  Deno.writeTextFileSync(tsconfigPath, JSON.stringify(tsconfig, null, 1));
  return { tsconfigPath, localFiles, pathCount: Object.keys(paths).length };
}

// ---------------------------------------------------------------------------
// Runner: toolchain, generation, compile, verdict. Shared by chipp-deno's
// scripts/check-project.ts and alchemist-template's scripts/check-types.ts.
// ---------------------------------------------------------------------------

export interface CommandResult {
  code: number;
  signal: string | null;
  stdout: string;
  stderr: string;
}

export type CommandRunner = (program: string, args: string[]) => Promise<CommandResult>;

export type TsgoVerdict =
  | { kind: "ok"; localFiles: number; seconds: number }
  | { kind: "type-errors"; diagnostics: TscDiagnostic[]; files: string[]; seconds: number }
  /** No verdict: the caller must fall back to `deno check`. */
  | { kind: "fallback"; reason: string };

/** npm package that carries the native compiler for this platform. */
export function nativeTscPackage(os: string, arch: string): string {
  const platform = os === "windows" ? "win32" : os;
  const cpu = arch === "x86_64" ? "x64" : arch === "aarch64" ? "arm64" : arch;
  return `@typescript/typescript-${platform}-${cpu}`;
}

/** `compilerOptions` from deno.json / deno.jsonc in `dir`, or `{}`. */
export function readDenoCompilerOptions(dir = "."): Record<string, unknown> {
  for (const name of ["deno.json", "deno.jsonc"]) {
    let text: string;
    try {
      text = Deno.readTextFileSync(`${dir}/${name}`);
    } catch {
      continue;
    }
    try {
      return (JSON.parse(text).compilerOptions ?? {}) as Record<string, unknown>;
    } catch {
      // JSONC: drop comments and trailing commas, outside strings only.
      const stripped = text.replace(
        /("(?:\\.|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g,
        (_m, str) => str ?? "",
      ).replace(/,(\s*[}\]])/g, "$1");
      return (JSON.parse(stripped).compilerOptions ?? {}) as Record<string, unknown>;
    }
  }
  return {};
}

async function denoInfoNpm(run: CommandRunner, spec: string): Promise<DenoInfo | null> {
  // --no-config/--no-lock: fetching the toolchain must never touch the
  // project's deno.lock or import map.
  const args = ["info", "--json", "--no-config", "--no-lock", spec];
  let result = await run("deno", args);
  if (result.code !== 0) result = await run("deno", args);
  if (result.code !== 0) return null;
  try {
    return JSON.parse(result.stdout) as DenoInfo;
  } catch {
    return null;
  }
}

export interface RunTsgoCheckOptions {
  /** `deno info --json` documents, one per entry point. */
  infos: DenoInfo[];
  /** Local files in the graph (sizes the memory plan). */
  localFileCount: number;
  availableMb: number;
  run: CommandRunner;
  log: (message: string) => void;
  /** Defaults to the current directory. */
  repoRoot?: string;
}

/**
 * Type-check a resolved graph with the native compiler. Env knobs:
 * `TSGO_BIN` (local compiler binary), `CHECK_TSGO_CHECKERS` (thread count),
 * `CHECK_TSGO_KEEP=1` (keep the generated project for debugging).
 */
export async function runTsgoCheck(opts: RunTsgoCheckOptions): Promise<TsgoVerdict> {
  const startedMs = Date.now();
  if (Deno.permissions.querySync({ name: "write" }).state !== "granted") {
    return { kind: "fallback", reason: "no --allow-write (the engine writes a generated tsconfig to a temp dir)" };
  }
  const plan = planTsgoMemory(opts.localFileCount, opts.availableMb);
  if (plan.kind === "insufficient") {
    return {
      kind: "fallback",
      reason: `~${plan.estimateMb}MB needed for ${opts.localFileCount} files, ${
        Math.round(opts.availableMb)
      }MB available`,
    };
  }

  // Toolchain: the platform binary and @types/node, through Deno's npm cache.
  let tscBin = Deno.env.get("TSGO_BIN") ?? "";
  if (!tscBin) {
    const pkg = nativeTscPackage(Deno.build.os, Deno.build.arch);
    const info = await denoInfoNpm(opts.run, `npm:${pkg}@${TS_NATIVE_VERSION}`);
    const local = Object.values(info?.npmPackages ?? {}).find((p) => p.name === pkg)?.localPath;
    if (!local) return { kind: "fallback", reason: `could not fetch npm:${pkg}@${TS_NATIVE_VERSION}` };
    tscBin = `${local}/lib/tsc${Deno.build.os === "windows" ? ".exe" : ""}`;
  }
  const typesNodeInfo = await denoInfoNpm(opts.run, `npm:@types/node@${TYPES_NODE_VERSION}`);
  if (!typesNodeInfo) {
    return { kind: "fallback", reason: `could not fetch npm:@types/node@${TYPES_NODE_VERSION}` };
  }
  const typesNodeId = Object.keys(typesNodeInfo.npmPackages ?? {}).find((id) =>
    id.startsWith("@types/node@")
  ) ?? null;

  const denoTypes = await opts.run("deno", ["types"]);
  if (denoTypes.code !== 0) return { kind: "fallback", reason: "`deno types` failed" };

  const repoRoot = Deno.realPathSync(opts.repoRoot ?? Deno.cwd());
  const outDir = Deno.realPathSync(await Deno.makeTempDir({ prefix: "check-tsgo-" }));
  const keep = Deno.env.get("CHECK_TSGO_KEEP") === "1";
  try {
    const project = generateTsgoProject({
      info: mergeInfos([...opts.infos, { npmPackages: typesNodeInfo.npmPackages }]),
      repoRoot,
      outDir,
      denoCompilerOptions: readDenoCompilerOptions(repoRoot),
      denoTypes: denoTypes.stdout,
      typesNodeId,
    });
    const threads = Deno.env.get("CHECK_TSGO_CHECKERS");
    const args = ["-p", project.tsconfigPath, "--pretty", "false"];
    if (threads) args.push("--checkers", threads);
    else if (plan.kind === "single-threaded") args.push("--singleThreaded");
    opts.log(
      `tsgo engine: TypeScript ${TS_NATIVE_VERSION} over ${project.localFiles.length} local file(s), ${project.pathCount} mapped specifier(s), ${
        threads ? `${threads} checker(s)` : plan.kind
      } (~${plan.estimateMb}MB est., ${Math.round(opts.availableMb)}MB available)`,
    );
    const result = await opts.run(tscBin, args);
    if (result.signal) {
      return { kind: "fallback", reason: `native tsc was killed by ${result.signal} (memory?)` };
    }
    const all = parseTscDiagnostics(result.stdout + "\n" + result.stderr);
    const kept = filterLikeDeno(all, {
      repoRoot,
      generatedRoot: outDir,
      resolve: (f) => new URL(f, `file://${repoRoot}/`).pathname,
    });
    const globalDiags = kept.filter((d) => d.file === null);
    if (globalDiags.length > 0) {
      // A diagnostic with no file is a configuration problem in the generated
      // project, not the user's code: never a type-error verdict.
      return {
        kind: "fallback",
        reason: `generated project has config error(s): ${
          globalDiags.map((d) => d.text).join(" | ").slice(0, 500)
        }`,
      };
    }
    if (result.code !== 0 && all.length === 0) {
      return {
        kind: "fallback",
        reason: `native tsc exited ${result.code} with no diagnostics: ${
          (result.stdout + result.stderr).slice(0, 500)
        }`,
      };
    }
    const seconds = Math.round((Date.now() - startedMs) / 100) / 10;
    if (kept.length > 0) {
      const files = [...new Set(kept.map((d) => d.file!))].sort();
      return { kind: "type-errors", diagnostics: kept, files, seconds };
    }
    return { kind: "ok", localFiles: project.localFiles.length, seconds };
  } finally {
    if (keep) opts.log(`kept the generated project at ${outDir}`);
    else await Deno.remove(outDir, { recursive: true }).catch(() => {});
  }
}
