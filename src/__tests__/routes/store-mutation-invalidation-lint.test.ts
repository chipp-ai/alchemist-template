/**
 * Store mutation invalidation lint (source-shape test, no DB, no browser).
 *
 * The bug class this guards: a store function writes to the API, but does
 * not invalidate every `createQuery` key that renders the changed data, so
 * some screen stays stale until its `staleTime` lapses or the user hard
 * refreshes. The dependency knowledge lives in
 * `web/src/lib/invalidation-map.ts`; this test makes sure every mutation
 * honours it.
 *
 * Rules:
 *   A. Every function in `web/src/stores/*.svelte.ts` that calls
 *      `api.post|put|patch|delete` must invalidate SOMETHING afterwards
 *      (`invalidateQueries(...)`, `invalidateEntity(...)`, or a helper that
 *      does), unless every path it writes to is listed in
 *      `NON_CACHED_WRITE_PATHS` (by path pattern, optionally narrowed by
 *      HTTP method, or by `{ file, fn }`), or the store is a plain
 *      `defineStore` (no `createQuery` in the file) that patches its own
 *      state.
 *   B. A function that writes to a path matching a row in
 *      `REQUIRED_PREFIXES_BY_WRITE_PATH` must invalidate every prefix that
 *      row requires. Prefix resolution follows `invalidateEntity("x")`,
 *      same-file helpers, `this.helper()` and helpers imported from
 *      another store or lib module, up to three hops.
 *
 * The parser is a deliberately small brace-matching scanner over the
 * comment-stripped source. It fails LOUDLY (assert) when it cannot
 * attribute a write to a function, so a parser gap never turns into a
 * silent pass.
 */
import { assert } from "@std/assert";
import {
  ENTITY_DEPENDENTS,
  NON_CACHED_WRITE_PATHS,
  REQUIRED_PREFIXES_BY_WRITE_PATH,
} from "../../../web/src/lib/invalidation-map.ts";

const WEB_SRC = new URL("../../../web/src/", import.meta.url);
const STORES_DIR = new URL("stores/", WEB_SRC);

const KEYWORDS = new Set([
  "if", "for", "while", "switch", "catch", "return", "await", "else", "new", "typeof",
  "import", "export", "throw", "yield", "delete", "void", "function", "constructor",
]);

interface FnInfo {
  name: string;
  body: string;
}

interface WriteSite {
  method: string;
  path: string; // static prefix
}

/** Remove block comments and full-line `//` / ` * ` comment lines. */
function stripComments(src: string): string {
  const noBlock = src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
  return noBlock
    .split("\n")
    .map((line) => {
      const t = line.trimStart();
      return t.startsWith("//") ? "" : line;
    })
    .join("\n");
}

/** Index of the `)` matching the `(` at `open`, skipping quoted strings. -1 if unbalanced. */
function matchParen(src: string, open: number): number {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      i = skipString(src, i);
      continue;
    }
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Index of the closing quote for the string opening at `i`. */
function skipString(src: string, i: number): number {
  const q = src[i];
  for (let j = i + 1; j < src.length; j++) {
    if (src[j] === "\\") {
      j++;
      continue;
    }
    if (src[j] === q) return j;
  }
  return src.length;
}

/** Index of the `}` matching the `{` at `open`, skipping quoted strings. */
function matchBrace(src: string, open: number): number {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (ch === '"' || ch === "'") {
      i = skipString(src, i);
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Given the index just after a parameter list's `)`, find the `{` that opens
 * the function body, skipping a return-type annotation. Returns -1 when a
 * statement terminator comes first (the match was a call, not a definition).
 */
function findBodyStart(src: string, from: number): number {
  let angle = 0;
  let prev = ")";
  for (let i = from; i < src.length; i++) {
    const ch = src[i];
    if (ch === ";" || (ch === ")" && angle === 0)) return -1;
    if (ch === "<") angle++;
    else if (ch === ">") {
      if (src[i - 1] === "=") {
        // `=>` arrow: the next `{` is the body
        prev = ">";
        continue;
      }
      angle = Math.max(0, angle - 1);
    } else if (ch === "{") {
      if (angle === 0 && !":|&=(,<".includes(prev)) return i;
      // object type inside an annotation: skip it wholesale
      const close = matchBrace(src, i);
      if (close === -1) return -1;
      i = close;
      prev = "}";
      continue;
    } else if (ch === "." && src[i + 1] === "." ) {
      return -1;
    }
    if (!/\s/.test(ch)) prev = ch;
  }
  return -1;
}

const FN_START_RE =
  /(?:^|\n)[ \t]*(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\s+)?(?:\*\s*)?([A-Za-z_$][\w$]*)\s*(?:<[^>()]*>)?\s*\(|(?:^|\n)[ \t]*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?\(|(?:^|\n)[ \t]*([A-Za-z_$][\w$]*)\s*:\s*(?:async\s*)?\(/g;

/** Every named function / method / arrow-const in the file, with its body text. */
function findFunctions(src: string): FnInfo[] {
  const out: FnInfo[] = [];
  for (const m of src.matchAll(FN_START_RE)) {
    const name = m[1] ?? m[2] ?? m[3];
    if (!name || KEYWORDS.has(name)) continue;
    const parenOpen = m.index! + m[0].length - 1;
    const parenClose = matchParen(src, parenOpen);
    if (parenClose === -1) continue;
    const bodyOpen = findBodyStart(src, parenClose + 1);
    if (bodyOpen === -1) continue;
    const bodyClose = matchBrace(src, bodyOpen);
    if (bodyClose === -1) continue;
    out.push({ name, body: src.slice(bodyOpen + 1, bodyClose) });
  }
  return out;
}

const WRITE_CALL_RE = /\bapi\.(post|put|patch|delete)\b/g;
/** `api.post<...>("literal" | `template` | helperFn(...)` -- the first argument shape. */
const WRITE_WITH_PATH_RE =
  /\bapi\.(post|put|patch|delete)\s*(?:<[\s\S]*?>)?\s*\(\s*(?:(["'`])([\s\S]*?)\2|([A-Za-z_$][\w$]*)\s*\()/g;

function staticPrefix(raw: string): string {
  const cut = raw.indexOf("${");
  return cut === -1 ? raw : raw.slice(0, cut);
}

/** A path-building helper must `return` one string/template literal. */
function helperPathPrefix(fns: Map<string, FnInfo>, name: string): string | null {
  const fn = fns.get(name);
  if (!fn) return null;
  const m = /return\s+(["'`])([\s\S]*?)\1/.exec(fn.body);
  return m ? staticPrefix(m[2]) : null;
}

function findWrites(body: string, where: string, fns: Map<string, FnInfo>): WriteSite[] {
  const total = [...body.matchAll(WRITE_CALL_RE)].length;
  const parsed: WriteSite[] = [];
  for (const m of body.matchAll(WRITE_WITH_PATH_RE)) {
    const path = m[3] !== undefined ? staticPrefix(m[3]) : helperPathPrefix(fns, m[4]);
    assert(
      path !== null,
      `${where}: the path of api.${m[1]}(${m[4]}(...)) could not be resolved; ` +
        "a path helper must return a single string or template literal.",
    );
    parsed.push({ method: m[1], path });
  }
  assert(
    parsed.length === total,
    `${where}: found ${total} api write call(s) but could parse the path of ${parsed.length}. ` +
      "Pass the path as a string literal, a template literal, or a same-file helper call as the first argument.",
  );
  return parsed;
}

interface Resolved {
  prefixes: Set<string>;
  /** true when an invalidation with a non-literal argument was seen */
  dynamic: boolean;
}

interface ModuleInfo {
  path: string;
  src: string;
  fns: Map<string, FnInfo>;
  consts: Map<string, string>;
  imports: Map<string, string>; // local name -> module path
}

const moduleCache = new Map<string, ModuleInfo>();

async function loadModule(path: string): Promise<ModuleInfo | null> {
  const cached = moduleCache.get(path);
  if (cached) return cached;
  let raw: string;
  try {
    raw = await Deno.readTextFile(path);
  } catch {
    return null;
  }
  const src = stripComments(raw);
  const fns = new Map<string, FnInfo>();
  for (const fn of findFunctions(src)) if (!fns.has(fn.name)) fns.set(fn.name, fn);
  const consts = new Map<string, string>();
  for (const m of src.matchAll(/(?:const|let)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(["'`])([^"'`$]*)\2/g)) {
    consts.set(m[1], m[3]);
  }
  const imports = new Map<string, string>();
  for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*["']([^"']+)["']/g)) {
    const spec = m[2];
    if (!spec.startsWith(".")) continue;
    const base = new URL(spec, "file://" + path).pathname;
    const target = base.endsWith(".ts") ? base : base + ".ts";
    for (const part of m[1].split(",")) {
      const seg = part.trim().replace(/^type\s+/, "");
      if (!seg) continue;
      const [orig, alias] = seg.split(/\s+as\s+/).map((s) => s.trim());
      imports.set(alias ?? orig, target);
    }
  }
  const info = { path, src, fns, consts, imports };
  moduleCache.set(path, info);
  return info;
}

const INVALIDATE_QUERIES_RE = /\binvalidateQueries\s*\(\s*([^)]*?)\s*\)/g;
const INVALIDATE_ENTITY_RE = /\binvalidateEntity\s*\(\s*["']([^"']+)["']\s*\)/g;
const CALL_RE = /(?:\bthis\.|(?:^|[^.\w$]))([A-Za-z_$][\w$]*)\s*\(/g;

async function resolvePrefixes(
  mod: ModuleInfo,
  body: string,
  out: Resolved,
  visited: Set<string>,
  depth: number,
): Promise<void> {
  for (const m of body.matchAll(INVALIDATE_QUERIES_RE)) {
    const arg = m[1];
    const lit = /^["']([^"']*)["']$/.exec(arg);
    const tpl = /^`([^`$]*)/.exec(arg);
    if (lit) out.prefixes.add(lit[1]);
    else if (tpl) out.prefixes.add(tpl[1]);
    else if (mod.consts.has(arg)) out.prefixes.add(mod.consts.get(arg)!);
    else out.dynamic = true;
  }
  for (const m of body.matchAll(INVALIDATE_ENTITY_RE)) {
    const deps = (ENTITY_DEPENDENTS as Record<string, readonly string[]>)[m[1]];
    assert(deps, `${mod.path}: invalidateEntity("${m[1]}") names an entity missing from invalidation-map.ts`);
    for (const p of deps) out.prefixes.add(p);
  }
  if (depth >= 3) return;
  for (const m of body.matchAll(CALL_RE)) {
    const name = m[1];
    if (name === "invalidateQueries" || name === "invalidateEntity") continue;
    let target: ModuleInfo | null = null;
    if (mod.fns.has(name)) target = mod;
    else if (mod.imports.has(name)) target = await loadModule(mod.imports.get(name)!);
    if (!target) continue;
    const fn = target.fns.get(name);
    if (!fn) continue;
    const key = `${target.path}#${name}`;
    if (visited.has(key)) continue;
    visited.add(key);
    await resolvePrefixes(target, fn.body, out, visited, depth + 1);
  }
}

type WriteRule = { path?: RegExp; method?: string; file?: string; fn?: string };

function ruleMatches(rule: WriteRule, w: WriteSite, file: string, fn: string): boolean {
  if (rule.method && rule.method.toLowerCase() !== w.method) return false;
  if (rule.file && rule.file !== file) return false;
  if (rule.fn && rule.fn !== fn) return false;
  if (rule.path && !rule.path.test(w.path)) return false;
  return Boolean(rule.path || rule.fn);
}

function covers(prefixes: Set<string>, required: string): boolean {
  for (const p of prefixes) if (required.startsWith(p) || p.startsWith(required)) return true;
  return false;
}

Deno.test("every store mutation invalidates the views it changes (invalidation-map lint)", async () => {
  const failures: string[] = [];
  let checked = 0;
  for await (const entry of Deno.readDir(STORES_DIR)) {
    if (!entry.isFile || !entry.name.endsWith(".ts")) continue;
    const path = new URL(entry.name, STORES_DIR).pathname;
    const mod = await loadModule(path);
    if (!mod) continue;
    const usesQueries = /\bcreateQuery\b/.test(mod.src) || /\binvalidateQueries\b|\binvalidateEntity\b/.test(mod.src);
    const totalWrites = [...mod.src.matchAll(WRITE_CALL_RE)].length;
    let attributed = 0;
    for (const fn of mod.fns.values()) {
      const where = `${entry.name} :: ${fn.name}()`;
      const writes = findWrites(fn.body, where, mod.fns);
      // nested function bodies are re-visited as their own FnInfo; count
      // only writes whose nearest enclosing function is this one
      const nestedWrites = findFunctions(fn.body).reduce(
        (n, inner) => n + [...inner.body.matchAll(WRITE_CALL_RE)].length,
        0,
      );
      const ownWrites = writes.slice(0, Math.max(0, writes.length - nestedWrites));
      if (ownWrites.length === 0) continue;
      attributed += ownWrites.length;
      checked++;
      const resolved: Resolved = { prefixes: new Set(), dynamic: false };
      await resolvePrefixes(mod, fn.body, resolved, new Set([`${path}#${fn.name}`]), 0);
      const patchesOwnState = !usesQueries && /\bstate\.[A-Za-z_$][\w$]*\s*=/.test(fn.body);
      const cachedWrites = ownWrites.filter((w) =>
        !NON_CACHED_WRITE_PATHS.some((r) => ruleMatches(r, w, entry.name, fn.name))
      );
      // Rule A
      if (cachedWrites.length > 0 && resolved.prefixes.size === 0 && !resolved.dynamic && !patchesOwnState) {
        failures.push(
          `${where} writes ${cachedWrites.map((w) => `${w.method.toUpperCase()} ${w.path}`).join(", ")} ` +
            "but never invalidates a query. Call invalidateEntity(...) / invalidateQueries(...), " +
            "or add the path to NON_CACHED_WRITE_PATHS with a reason.",
        );
      }
      // Rule B
      for (const w of ownWrites) {
        for (const rule of REQUIRED_PREFIXES_BY_WRITE_PATH) {
          if (!ruleMatches(rule, w, entry.name, fn.name)) continue;
          const missing = [...new Set(rule.requires)].filter((req) => !covers(resolved.prefixes, req));
          if (missing.length > 0) {
            failures.push(
              `${where} writes ${w.method.toUpperCase()} ${w.path} but does not invalidate ` +
                `${missing.map((p) => `"${p}"`).join(", ")}. Why: ${rule.why}`,
            );
          }
        }
      }
    }
    assert(
      attributed === totalWrites,
      `${entry.name}: ${totalWrites} api write call(s) in the file, ${attributed} attributed to a named function. ` +
        "The lint could not parse the enclosing function of a write; give it a named function or method.",
    );
  }
  assert(checked > 0, "lint found no store mutations at all; the parser or STORES_DIR is wrong");
  assert(failures.length === 0, `\n${failures.map((f) => `- ${f}`).join("\n")}\n`);
});
