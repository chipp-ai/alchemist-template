/**
 * web/public/brand-loader.js runs against a small fake DOM: a full,
 * old-style brand.json (colors, fonts, radius) must change none of the
 * look, while the title, logos, favicon and gradient still apply.
 *
 * Why: brand.json used to be applied last and won over design.json, so a
 * look changed in code reverted on Publish. design.json is now the only
 * source of the look.
 */

import { assert, assertEquals } from "@std/assert";

const LOADER = await Deno.readTextFile(new URL("../../web/public/brand-loader.js", import.meta.url));

class FakeStyle {
  props = new Map<string, string>();
  setProperty(k: string, v: string) {
    this.props.set(k, v);
  }
}

class FakeEl {
  attrs = new Map<string, string>();
  style = new FakeStyle();
  id = "";
  rel = "";
  constructor(public tag: string) {}
  getAttribute(k: string) {
    return this.attrs.has(k) ? this.attrs.get(k)! : null;
  }
  setAttribute(k: string, v: string) {
    this.attrs.set(k, v);
  }
  removeAttribute(k: string) {
    this.attrs.delete(k);
  }
}

function makeEnv(brand: Record<string, unknown>) {
  const root = new FakeEl("html");
  const head: FakeEl[] = [];
  const lightLogo = new FakeEl("img");
  lightLogo.setAttribute("data-brand-logo", "light");
  lightLogo.setAttribute("hidden", "");
  const darkLogo = new FakeEl("img");
  darkLogo.setAttribute("data-brand-logo", "dark");
  const document = {
    title: "Loading…",
    readyState: "complete",
    documentElement: root,
    head: { appendChild: (el: FakeEl) => head.push(el) },
    getElementById: (id: string) => head.find((e) => e.id === id) ?? null,
    createElement: (tag: string) => new FakeEl(tag),
    querySelectorAll: (sel: string) => (sel === "img[data-brand-logo]" ? [lightLogo, darkLogo] : []),
    addEventListener: () => {},
  };
  const window = {
    ALCHEMIST_PROJECT_ID: "11111111-1111-1111-1111-111111111111",
    ALCHEMIST_PLATFORM_ORIGIN: "https://platform.test",
    location: { host: "app.test" },
    matchMedia: () => ({ matches: false }),
  } as Record<string, unknown>;
  const fetchCalls: string[] = [];
  const fetch = (url: string) => {
    fetchCalls.push(url);
    return Promise.resolve({
      status: 200,
      ok: true,
      headers: { get: () => '"v3"' },
      json: () => Promise.resolve(brand),
    });
  };
  const console = { warn: () => {} };
  new Function("window", "document", "fetch", "console", "EventSource", LOADER)(
    window,
    document,
    fetch,
    console,
    undefined,
  );
  return { root, head, lightLogo, darkLogo, document, fetchCalls, window };
}

const FULL_OLD_BRAND = {
  productName: "Acme",
  primaryColor: "#16a34a",
  accentColor: "#f59e0b",
  neutralColor: "#fafafa",
  fontHeading: "Fraunces",
  fontBody: "Inter",
  radiusScale: "round",
  gradient: { from: "#111111", to: "#eeeeee" },
  logoUrl: "/api/public/brand-assets/light.png",
  logoUrlDark: "https://cdn.test/dark.png",
  faviconUrl: "/api/public/brand-assets/fav.png",
  version: 3,
};

async function settle() {
  for (let i = 0; i < 5; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
}

Deno.test("brand-loader: colors, fonts and radius from brand.json are ignored", async () => {
  const env = makeEnv(FULL_OLD_BRAND);
  await settle();
  for (
    const k of [
      "--brand-primary",
      "--brand-accent",
      "--brand-neutral",
      "--brand-primary-contrast",
      "--brand-font-heading",
      "--brand-font-body",
      "--brand-radius-scale",
    ]
  ) {
    assert(!env.root.style.props.has(k), `${k} must not be set`);
  }
  assertEquals(env.root.getAttribute("data-radius-scale"), null);
  assert(!env.head.some((e) => e.id === "alchemist-brand-fonts"), "no font link");
});

Deno.test("brand-loader: title, logos, favicon and gradient still apply", async () => {
  const env = makeEnv(FULL_OLD_BRAND);
  await settle();
  assertEquals(env.fetchCalls[0], "https://platform.test/api/public/brand/11111111-1111-1111-1111-111111111111/brand.json");
  assertEquals(env.document.title, "Acme");
  assertEquals(env.lightLogo.getAttribute("src"), "https://platform.test/api/public/brand-assets/light.png");
  assertEquals(env.lightLogo.getAttribute("hidden"), null, "a logo with a src is shown");
  assertEquals(env.darkLogo.getAttribute("src"), "https://cdn.test/dark.png");
  const favicon = env.head.find((e) => e.id === "alchemist-brand-favicon");
  assertEquals(favicon?.rel, "icon");
  assertEquals(favicon?.getAttribute("href"), "https://platform.test/api/public/brand-assets/fav.png");
  assertEquals(env.root.style.props.get("--brand-gradient-from"), "#111111");
  assertEquals(env.root.style.props.get("--brand-gradient-to"), "#eeeeee");
});

Deno.test("brand-loader: no logo keeps the image hidden (text name stays the fallback)", async () => {
  const env = makeEnv({ productName: "Acme", version: 1 });
  await settle();
  assertEquals(env.lightLogo.getAttribute("hidden"), "");
  assertEquals(env.lightLogo.getAttribute("src"), null);
});

Deno.test("brand-loader: alchemistBrandReapply fills a logo slot that mounted later", async () => {
  const env = makeEnv(FULL_OLD_BRAND);
  await settle();
  env.lightLogo.removeAttribute("src");
  env.lightLogo.setAttribute("hidden", "");
  const w = env.window as { alchemistBrandReapply?: () => void };
  w.alchemistBrandReapply?.();
  assertEquals(env.lightLogo.getAttribute("src"), "https://platform.test/api/public/brand-assets/light.png");
});

Deno.test("designEmailColorsSync: reads primary, accent and background; empty when missing", async () => {
  const { designEmailColorsSync } = await import("../config/brand.ts");
  const dir = await Deno.makeTempDir();
  const path = `${dir}/design.json`;
  await Deno.writeTextFile(path, JSON.stringify({ colors: { primary: "#16a34a", accent: "#f59e0b", background: "#fafaf9" } }));
  assertEquals(designEmailColorsSync(path), { primary: "#16a34a", accent: "#f59e0b", neutral: "#fafaf9" });
  assertEquals(designEmailColorsSync(`${dir}/missing.json`), {});
  await Deno.remove(dir, { recursive: true });
});
