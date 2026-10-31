/**
 * The old-URL gate for a migrated site.
 *
 *   deno task check:old-urls [baseUrl]
 *
 * Reads chipp/site-migration/old-urls.json ({ "origin": ..., "paths": [...] },
 * written by Chipp when it crawled the old site) and requests every path
 * against the running app (default http://localhost:$PORT, else :8000).
 * A path passes when it answers:
 *   - 200 with a real page, or
 *   - 301/302 to a same-site URL that answers 200 with a real page (one hop).
 * Anything else fails, and so does a 200 from the app's catch-all (the
 * X-Spa-Fallback header, app.ts): that is the SPA shell at a path with no
 * page, a soft 404. Every failure is printed; the exit code is 1 when any
 * path fails, 0 when all pass or the file does not exist.
 *
 * Fix a failure by rebuilding the page at its old path, or, only when the
 * path must change, by adding a redirect to chipp/redirects.json.
 */

export interface OldUrlsFile {
  origin?: string;
  paths: string[];
}

export interface OldUrlResult {
  path: string;
  ok: boolean;
  /** What happened, e.g. "200", "301 -> /new/ -> 200", "404". */
  detail: string;
}

const REDIRECTS = new Set([301, 302]);

async function request(url: URL): Promise<Response> {
  const res = await fetch(url, { redirect: "manual", headers: { "user-agent": "chipp-old-url-check" } });
  await res.body?.cancel();
  return res;
}

function isRealPage(res: Response): boolean {
  return res.status === 200 && res.headers.get("x-spa-fallback") !== "1";
}

/** Check one path against the base URL, following at most one redirect. */
export async function checkOldUrl(base: URL, path: string): Promise<OldUrlResult> {
  let first: Response;
  const url = new URL(path, base);
  try {
    first = await request(url);
  } catch (err) {
    return { path, ok: false, detail: `request failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (first.status === 200) {
    return isRealPage(first)
      ? { path, ok: true, detail: "200" }
      : { path, ok: false, detail: "200 from the app's catch-all: there is no page at this path" };
  }
  if (!REDIRECTS.has(first.status)) {
    const hint = [307, 308].includes(first.status) ? " (use 301 or 302)" : "";
    return { path, ok: false, detail: `${first.status}${hint}` };
  }
  const location = first.headers.get("location");
  if (!location) return { path, ok: false, detail: `${first.status} without a Location header` };
  const target = new URL(location, url);
  if (target.origin !== base.origin) {
    return { path, ok: false, detail: `${first.status} -> ${target.href}: redirects off this site` };
  }
  const hop = `${first.status} -> ${target.pathname}${target.search}`;
  let second: Response;
  try {
    second = await request(target);
  } catch (err) {
    return { path, ok: false, detail: `${hop} -> request failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (isRealPage(second)) return { path, ok: true, detail: `${hop} -> 200` };
  if (second.status === 200) return { path, ok: false, detail: `${hop} -> 200 from the app's catch-all: no page there` };
  return { path, ok: false, detail: `${hop} -> ${second.status}${REDIRECTS.has(second.status) ? " (a second redirect; point the first one at the final page)" : ""}` };
}

/** Check every path, a few at a time. Results keep the input order. */
export async function checkOldUrls(base: URL, paths: string[], concurrency = 8): Promise<OldUrlResult[]> {
  const results: OldUrlResult[] = new Array(paths.length);
  let next = 0;
  const worker = async () => {
    while (next < paths.length) {
      const i = next++;
      results[i] = await checkOldUrl(base, paths[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, paths.length) }, worker));
  return results;
}

/** Parse old-urls.json. Throws with a readable message on a bad shape. */
export function parseOldUrls(text: string): OldUrlsFile {
  const data = JSON.parse(text);
  if (!data || !Array.isArray(data.paths) || !data.paths.every((p: unknown) => typeof p === "string")) {
    throw new Error('old-urls.json must be { "origin": "...", "paths": ["/", ...] }');
  }
  const paths = [...new Set<string>(data.paths.map((p: string) => (p.startsWith("/") ? p : `/${p}`)))];
  return { origin: typeof data.origin === "string" ? data.origin : undefined, paths };
}

if (import.meta.main) {
  const file = "chipp/site-migration/old-urls.json";
  let text: string;
  try {
    text = await Deno.readTextFile(file);
  } catch {
    console.log(`[check:old-urls] ${file} not found; nothing to check.`);
    Deno.exit(0);
  }
  const { origin, paths } = parseOldUrls(text);
  const base = new URL(Deno.args[0] ?? `http://localhost:${Deno.env.get("PORT") ?? "8000"}`);
  console.log(`[check:old-urls] ${paths.length} old URL(s)${origin ? ` from ${origin}` : ""} against ${base.origin}`);
  const results = await checkOldUrls(base, paths);
  const failures = results.filter((r) => !r.ok);
  for (const f of failures) console.error(`  FAIL ${f.path}  ${f.detail}`);
  if (failures.length > 0) {
    console.error(
      `[check:old-urls] ${failures.length} of ${paths.length} old URL(s) fail. Rebuild each page at its old path, ` +
        `or add a 301 to chipp/redirects.json when the path must change.`,
    );
    Deno.exit(1);
  }
  console.log(`[check:old-urls] OK: all ${paths.length} old URL(s) answer 200 or redirect to a 200.`);
}
