/**
 * Redirects for the public site: `chipp/redirects.json` at the repo root.
 *
 *   { "redirects": [ { "from": "/old", "to": "/new", "status": 301 } ] }
 *
 * One file serves both front ends. The Deno server applies it to every path
 * that no page and no app route answers (src/lib/site-redirects.ts), and
 * `astro dev` applies it in the landing preview (astro.config.mjs). The
 * Astro build and the server tests validate it with `validateRedirects`, so
 * a bad file fails the build before it can ship.
 *
 * No imports: the Deno server, the Deno tests and astro.config.mjs all load
 * this file directly.
 */

export type RedirectStatus = 301 | 302;

export interface SiteRedirect {
  /** A site path, starting with "/". Matched with and without a trailing slash. */
  from: string;
  /** A site path ("/new/") or an absolute http(s) URL. */
  to: string;
  status: RedirectStatus;
}

export interface RedirectsFile {
  redirects: SiteRedirect[];
}

/**
 * The key a path is matched by: no query, no fragment, no trailing slash
 * (except "/" itself). "/About/" and "/About" match; "/about" does not
 * match "/About", because paths are case sensitive on the old sites too.
 */
export function redirectKey(path: string): string {
  const bare = path.split(/[?#]/, 1)[0] || "/";
  if (bare === "/") return "/";
  return bare.replace(/\/+$/, "") || "/";
}

function isSitePath(value: string): boolean {
  return value.startsWith("/") && !value.startsWith("//") && !/[\s\\]/.test(value);
}

function isAbsoluteHttp(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Check a parsed redirects file. Returns a list of problems; empty means
 * valid. Rules:
 *   - the file is `{ "redirects": [...] }`
 *   - `from` starts with "/" (a site path, never a full URL)
 *   - `to` is a site path or an absolute http(s) URL
 *   - `status` is 301 or 302
 *   - no two rules share a `from`
 *   - no rule points at itself, and no chain of rules loops
 */
export function validateRedirects(value: unknown): string[] {
  const problems: string[] = [];
  if (!value || typeof value !== "object" || !Array.isArray((value as RedirectsFile).redirects)) {
    return ['the file must be an object with a "redirects" array'];
  }
  const list = (value as RedirectsFile).redirects;
  const seen = new Map<string, number>();
  list.forEach((r, i) => {
    const where = `redirects[${i}]`;
    if (!r || typeof r !== "object") {
      problems.push(`${where}: must be an object`);
      return;
    }
    if (typeof r.from !== "string" || !isSitePath(r.from)) {
      problems.push(`${where}: "from" must be a site path that starts with "/" (got ${JSON.stringify(r.from)})`);
    }
    if (typeof r.to !== "string" || !(isSitePath(r.to) || isAbsoluteHttp(r.to))) {
      problems.push(`${where}: "to" must be a site path or an http(s) URL (got ${JSON.stringify(r.to)})`);
    }
    if (r.status !== 301 && r.status !== 302) {
      problems.push(`${where}: "status" must be 301 or 302 (got ${JSON.stringify(r.status)})`);
    }
    if (typeof r.from === "string") {
      const key = redirectKey(r.from);
      if (seen.has(key)) problems.push(`${where}: "${r.from}" is already redirected by redirects[${seen.get(key)}]`);
      else seen.set(key, i);
      if (typeof r.to === "string" && isSitePath(r.to) && redirectKey(r.to) === key) {
        problems.push(`${where}: "${r.from}" redirects to itself`);
      }
    }
  });
  if (problems.length > 0) return problems;
  problems.push(...findLoops(list));
  return problems;
}

/** Every loop in the rules, once each, as "a -> b -> a". */
function findLoops(list: SiteRedirect[]): string[] {
  const next = new Map<string, string>();
  for (const r of list) {
    if (isSitePath(r.to)) next.set(redirectKey(r.from), redirectKey(r.to));
  }
  const loops: string[] = [];
  const reported = new Set<string>();
  for (const start of next.keys()) {
    const chain = [start];
    const onChain = new Set(chain);
    let at = next.get(start);
    while (at !== undefined) {
      if (onChain.has(at)) {
        const cycle = chain.slice(chain.indexOf(at));
        const id = [...cycle].sort().join("|");
        if (!reported.has(id)) {
          reported.add(id);
          loops.push(`redirect loop: ${[...cycle, at].join(" -> ")}`);
        }
        break;
      }
      chain.push(at);
      onChain.add(at);
      at = next.get(at);
    }
  }
  return loops;
}

/** A lookup from a request path to its rule. Build once per file. */
export function redirectTable(list: SiteRedirect[]): Map<string, SiteRedirect> {
  return new Map(list.map((r) => [redirectKey(r.from), r]));
}

/**
 * The Location for a matched rule. A site-path target keeps the request's
 * query string when it has none of its own, so tracking links survive.
 */
export function redirectLocation(rule: SiteRedirect, search: string): string {
  if (!search || rule.to.includes("?") || !isSitePath(rule.to)) return rule.to;
  return `${rule.to}${search.startsWith("?") ? search : `?${search}`}`;
}
