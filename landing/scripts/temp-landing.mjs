// Test helpers: build a real landing site in a temp copy of landing/.
// Used by site-migration.test.mjs and agent-facts.test.mjs.
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const LANDING = join(dirname(fileURLToPath(import.meta.url)), "..");
export const REPO = join(LANDING, "..");

/**
 * A temp repo with a copy of landing/ (shared node_modules) and
 * web/src/design. Starts from the template's own content: no composed pages
 * or posts. `siteJson` replaces site.json; `chippDir` is copied to chipp/.
 */
export function tempRepo({ siteJson, chippDir } = {}) {
  const root = mkdtempSync(join(tmpdir(), "landing-site-"));
  const skip = new Set(["node_modules", "dist", ".astro"]);
  cpSync(LANDING, join(root, "landing"), {
    recursive: true,
    filter: (src) => !relative(LANDING, src).split(sep).some((part) => skip.has(part)),
  });
  // One symlink per package, not one for node_modules: each temp build gets
  // its own node_modules/.vite cache, so test files that build in parallel
  // do not race on it.
  const modules = join(root, "landing", "node_modules");
  mkdirSync(modules);
  for (const entry of readdirSync(join(LANDING, "node_modules"))) {
    if (entry !== ".vite") symlinkSync(join(LANDING, "node_modules", entry), join(modules, entry));
  }
  cpSync(join(REPO, "web", "src", "design"), join(root, "web", "src", "design"), { recursive: true });
  rmSync(join(root, "landing", "src", "content", "pages"), { recursive: true, force: true });
  rmSync(join(root, "landing", "src", "content", "posts"), { recursive: true, force: true });
  if (siteJson) writeFileSync(join(root, "landing", "src", "content", "site.json"), JSON.stringify(siteJson, null, 2));
  if (chippDir) cpSync(chippDir, join(root, "chipp"), { recursive: true });
  return root;
}

/** Run `astro build` in a temp repo; returns the dist path. */
export function build(root) {
  const landing = join(root, "landing");
  execFileSync(process.execPath, [join(landing, "node_modules", "astro", "bin", "astro.mjs"), "build", "--silent"], {
    cwd: landing,
    stdio: "pipe",
  });
  return join(landing, "dist");
}
