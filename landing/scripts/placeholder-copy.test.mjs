// Tests for scripts/placeholder-copy.mjs, plus the check on this repo's
// real site.json. Run with: npm test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  BASE_ROUTE_FILES,
  TEMPLATE_PLACEHOLDER_NAME,
  findPlaceholderCopy,
  loadRepoState,
  projectIsBuiltOn,
} from "./placeholder-copy.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const realCopy = {
  name: "Acme",
  definition: {
    what: "Acme is a web app that tracks work orders from request to sign-off.",
    who: "It is for facilities teams at schools and hospitals.",
    does: "It keeps every request, photo and sign-off in one shared place.",
  },
  about: { answer: "Acme is made by two former facilities managers." },
};

test("real copy has no placeholder", () => {
  assert.deepEqual(findPlaceholderCopy(realCopy), []);
});

test("the seeded fallbacks are placeholders", () => {
  const seeded = {
    name: "Acme",
    definition: {
      what: "Acme is a web app.",
      who: "It is for anyone who needs what Acme does.",
      does: "Acme runs in the browser, so there is nothing to install.",
    },
    about: { answer: "Acme is made by the team that runs it." },
  };
  const found = findPlaceholderCopy(seeded);
  assert.equal(found.length, 4, found.join("\n"));
});

test("the template's own copy is a placeholder", () => {
  const found = findPlaceholderCopy({ name: "Your product", definition: { what: "Your product is a web app that helps a team do one job well." } });
  assert.ok(found.some((f) => f.startsWith("name:")), found.join("\n"));
});

test("a project with only base routes is new; one more route means built on", () => {
  assert.equal(projectIsBuiltOn([...BASE_ROUTE_FILES]), false);
  assert.equal(projectIsBuiltOn([...BASE_ROUTE_FILES, "Orders.svelte"]), true);
});

// The real check. A new project may still hold its draft copy; a project
// with its own app pages may not. Fix it in landing/src/content/site.json,
// or, for an app-first product, set "homepage": "app" there: the server
// then serves the app at "/" and never serves this copy.
const { site, routeFiles, strayAppFolders } = loadRepoState(REPO_ROOT);
const builtOn = projectIsBuiltOn(routeFiles) || strayAppFolders.length > 0;
const appFirst = site.homepage === "app";

test("this repo: build only in web/ or landing/", () => {
  assert.deepEqual(
    strayAppFolders,
    [],
    `These folders are separate front ends that nothing builds or deploys: ${strayAppFolders.join(", ")}. ` +
      `Build the app in web/ (served at /app, and at "/" with "homepage": "app" in site.json) and the marketing pages in landing/.`,
  );
});

test("this repo: no factory placeholder copy once the project is built on", { skip: !builtOn || appFirst }, () => {
  const found = findPlaceholderCopy(site);
  assert.deepEqual(
    found,
    [],
    `landing/src/content/site.json still holds factory placeholder copy, but the app has its own pages. ` +
      `The landing site at "/" must describe the real product. If the app IS the homepage, set ` +
      `"homepage": "app" in site.json instead:\n  ${found.join("\n  ")}`,
  );
});

test("template repo: BASE_ROUTE_FILES matches web/src/routes", { skip: site.name !== TEMPLATE_PLACEHOLDER_NAME }, () => {
  assert.deepEqual(routeFiles, [...BASE_ROUTE_FILES].sort());
});
