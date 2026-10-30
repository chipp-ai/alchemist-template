/**
 * The app's error boundary and the Chipp Builder preview
 * (web/src/lib/app-error.ts, web/src/components/AppErrorBoundary.svelte).
 *
 * Inside the Builder preview, a crash goes to the Builder's dev overlay
 * (`chipp:app-error`) and the app renders one plain line, so its own crash
 * screen does not compete with the overlay. Pure logic plus source checks:
 * no DOM, no database.
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  APP_ERROR_EVENT,
  isInBuilderPreview,
  PREVIEW_FLAG,
  reportAppError,
  toAppErrorDetail,
} from "../../web/src/lib/app-error.ts";

Deno.test("isInBuilderPreview reads the flag the preview bridge sets", () => {
  const win: Record<string, unknown> = {};
  assertEquals(isInBuilderPreview(win), false);
  win[PREVIEW_FLAG] = 1;
  assertEquals(isInBuilderPreview(win), true);
  assertEquals(isInBuilderPreview(null), false);
});

Deno.test("reportAppError dispatches chipp:app-error with the message and stack", () => {
  const events: Event[] = [];
  const win = { dispatchEvent: (e: Event) => events.push(e) > 0 };
  const err = new TypeError("x is undefined");
  reportAppError(err, win);
  assertEquals(events.length, 1);
  assertEquals(events[0].type, APP_ERROR_EVENT);
  const detail = (events[0] as CustomEvent).detail;
  assertEquals(detail.message, "TypeError: x is undefined");
  assertStringIncludes(detail.stack, "x is undefined");
});

Deno.test("reportAppError never throws", () => {
  reportAppError(new Error("a"), null);
  reportAppError(new Error("a"), {
    dispatchEvent: () => {
      throw new Error("no listener for you");
    },
  });
});

Deno.test("toAppErrorDetail describes any thrown value", () => {
  assertEquals(toAppErrorDetail("plain").message, "plain");
  assertEquals(toAppErrorDetail({ code: 7 }).message, '{"code":7}');
  assertEquals(toAppErrorDetail(new Error("")).message, "Error");
  const already = new Error("Error: twice");
  assertEquals(toAppErrorDetail(already).message, "Error: twice");
});

Deno.test("the boundary reports every error and draws one line inside the preview", async () => {
  const src = await Deno.readTextFile(new URL("../../web/src/components/AppErrorBoundary.svelte", import.meta.url));
  assertStringIncludes(src, "<svelte:boundary onerror={handleError}>");
  assertStringIncludes(src, "reportAppError(error);");
  const line = src.indexOf("{#if inBuilderPreview}");
  const full = src.indexOf("{:else}", line);
  assert(line !== -1 && full > line);
  assertStringIncludes(src.slice(line, full), 'data-testid="app-error-preview-line"');
  assert(!src.slice(line, full).includes("<button"));
});

Deno.test("App.svelte wraps the routed pages in the boundary", async () => {
  const app = await Deno.readTextFile(new URL("../../web/src/App.svelte", import.meta.url));
  assertStringIncludes(app, 'import AppErrorBoundary from "./components/AppErrorBoundary.svelte";');
  const opens = app.split("<AppErrorBoundary>").length - 1;
  const routers = app.split("<Router {routes} />").length - 1;
  assertEquals(opens, routers);
  for (const block of app.split("<AppErrorBoundary>").slice(1)) {
    assert(block.indexOf("<Router {routes} />") < block.indexOf("</AppErrorBoundary>"));
  }
});
