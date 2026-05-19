/**
 * Client-side breadcrumb collector — hooks into the major browser
 * surfaces and ships every event to the server's
 * /api/_observability/breadcrumb endpoint for inclusion in the
 * unified JSONL stream at `.scratch/logs/observability.jsonl`.
 *
 * Hooked surfaces:
 *   • console.{log,info,warn,error,debug}
 *   • window.error (uncaught exceptions)
 *   • window.unhandledrejection (promise rejections)
 *   • fetch + XMLHttpRequest (network round-trips)
 *   • document click (interactive + background)
 *   • history pushState / replaceState / popstate (route changes)
 *   • PerformanceObserver: LCP / CLS / INP (perf signals)
 *   • document.visibilitychange + pagehide (session lifecycle)
 *
 * Batching: events accumulate in an in-memory queue, flushed every
 * 1000ms OR when the queue hits 50 events. On `pagehide`, the flush
 * uses navigator.sendBeacon so the final batch survives the unload.
 *
 * Trust + recursion: we DO log captured console.error events, but
 * the breadcrumb dispatcher itself never calls console.* on the
 * happy path (only when the collector POST errors, and even then
 * with a `__obs:` prefix that the console hook can filter out to
 * prevent infinite loops).
 *
 * Production: this whole module is no-op'd when import.meta.env.PROD
 * is true. The analytics product will replace the collector POST
 * with a remote ingest call when it lands.
 */

const COLLECTOR_PATH = "/api/_observability/breadcrumb";
const BATCH_FLUSH_MS = 1000;
const BATCH_SIZE_CAP = 50;
const FETCH_BODY_PREVIEW_CAP = 4 * 1024; // 4 KB
const RESPONSE_BODY_PREVIEW_CAP = 4 * 1024;
const CONSOLE_OBS_PREFIX = "__obs:"; // re-entrancy guard for the dispatcher's own console writes

type ObsSource = "client";

interface ObsEvent {
  ts: string;
  sid: string;
  source: ObsSource;
  kind: string;
  data: Record<string, unknown>;
}

// Per-page-load session id. Survives SPA route changes (since SPA
// nav doesn't reload the page) but a hard reload mints a new sid.
function newSid(): string {
  return `cli-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

const SID = newSid();

let queue: ObsEvent[] = [];
let flushTimer: number | null = null;

function record(kind: string, data: Record<string, unknown>): void {
  queue.push({
    ts: new Date().toISOString(),
    sid: SID,
    source: "client",
    kind,
    data,
  });
  if (queue.length >= BATCH_SIZE_CAP) {
    flush();
  } else if (flushTimer === null) {
    flushTimer = window.setTimeout(flush, BATCH_FLUSH_MS);
  }
}

function flush(): void {
  if (flushTimer !== null) {
    window.clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (queue.length === 0) return;
  const batch = queue;
  queue = [];
  const payload = JSON.stringify({ events: batch });
  // fetch with keepalive so it survives a route change. Errors are
  // swallowed — we never want observability to block user action.
  // Use originalFetch to dodge our own fetch hook (would create an
  // infinite event loop).
  try {
    originalFetch.call(window, COLLECTOR_PATH, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: payload,
      keepalive: true,
      credentials: "same-origin",
    }).catch((e) => {
      originalConsole.warn.call(console, CONSOLE_OBS_PREFIX, "flush failed:", e);
    });
  } catch (e) {
    originalConsole.warn.call(console, CONSOLE_OBS_PREFIX, "flush threw:", e);
  }
}

function flushSync(): void {
  if (queue.length === 0) return;
  const batch = queue;
  queue = [];
  // sendBeacon survives the page unload path. Subject to a 64 KB
  // body limit; with our batch cap that's well under for typical
  // events.
  try {
    const blob = new Blob([JSON.stringify({ events: batch })], {
      type: "application/json",
    });
    navigator.sendBeacon(COLLECTOR_PATH, blob);
  } catch {
    // even sendBeacon can throw if the page is fully unloading —
    // there's nothing more we can do.
  }
}

// ── Originals (captured before we install hooks) ─────────────────

const originalFetch = window.fetch.bind(window);
const originalConsole = {
  log: console.log,
  info: console.info,
  warn: console.warn,
  error: console.error,
  debug: console.debug,
};
const originalXHROpen = XMLHttpRequest.prototype.open;
const originalXHRSend = XMLHttpRequest.prototype.send;
const originalPushState = history.pushState.bind(history);
const originalReplaceState = history.replaceState.bind(history);

// ── Hooks ────────────────────────────────────────────────────────

function installConsoleHook(): void {
  (["log", "info", "warn", "error", "debug"] as const).forEach((level) => {
    const original = originalConsole[level];
    console[level] = function (...args: unknown[]) {
      // Re-entrancy guard: our own dispatcher errors get logged
      // with __obs: prefix; ignore those to avoid infinite loops.
      if (typeof args[0] === "string" && args[0].startsWith(CONSOLE_OBS_PREFIX)) {
        return original.apply(console, args);
      }
      try {
        record(`client.console.${level}`, { args: argsToSerializable(args) });
      } catch {
        // never surface
      }
      return original.apply(console, args);
    };
  });
}

function installErrorHooks(): void {
  window.addEventListener("error", (e: ErrorEvent) => {
    record("client.error", {
      message: e.message,
      filename: e.filename,
      lineno: e.lineno,
      colno: e.colno,
      stack: e.error instanceof Error ? e.error.stack : undefined,
    });
  });
  window.addEventListener("unhandledrejection", (e: PromiseRejectionEvent) => {
    const reason = e.reason;
    record("client.promise", {
      message: reason instanceof Error ? reason.message : String(reason),
      stack: reason instanceof Error ? reason.stack : undefined,
    });
  });
}

function installFetchHook(): void {
  window.fetch = async function (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    const startedAt = performance.now();
    const method = (init?.method ?? "GET").toUpperCase();
    const url = typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;
    // Don't instrument our own collector posts.
    if (url.endsWith(COLLECTOR_PATH)) {
      return originalFetch.call(window, input, init);
    }
    const reqBodyPreview = previewBody(init?.body);
    try {
      const res = await originalFetch.call(window, input, init);
      const durationMs = Math.round(performance.now() - startedAt);
      // Clone the response so we can peek at the body without
      // consuming it for the caller. Only peek if content-type is
      // text-ish; binary responses are noted by size only.
      const peek = await peekResponseBody(res);
      record("client.fetch", {
        method,
        url,
        status: res.status,
        durationMs,
        requestBodyPreview: reqBodyPreview,
        responseBodyPreview: peek.preview,
        responseBytes: peek.bytes,
        ok: res.ok,
      });
      return res;
    } catch (e) {
      const durationMs = Math.round(performance.now() - startedAt);
      record("client.fetch", {
        method,
        url,
        durationMs,
        requestBodyPreview: reqBodyPreview,
        error: e instanceof Error ? e.message : String(e),
        ok: false,
      });
      throw e;
    }
  };
}

function installXHRHook(): void {
  XMLHttpRequest.prototype.open = function (
    this: XMLHttpRequest,
    method: string,
    url: string | URL,
    async?: boolean,
    username?: string | null,
    password?: string | null,
  ): void {
    // Stash on the instance so `send` can read them later.
    // deno-lint-ignore no-explicit-any
    (this as any).__obs_method = method.toUpperCase();
    // deno-lint-ignore no-explicit-any
    (this as any).__obs_url = typeof url === "string" ? url : url.toString();
    // deno-lint-ignore no-explicit-any
    (this as any).__obs_startedAt = performance.now();
    return originalXHROpen.call(this, method, url as string, async ?? true, username ?? undefined, password ?? undefined);
  };
  XMLHttpRequest.prototype.send = function (
    this: XMLHttpRequest,
    body?: Document | XMLHttpRequestBodyInit | null,
  ): void {
    // deno-lint-ignore no-explicit-any
    const self = this as any;
    if (self.__obs_url && !String(self.__obs_url).endsWith(COLLECTOR_PATH)) {
      this.addEventListener("loadend", () => {
        const durationMs = Math.round(performance.now() - self.__obs_startedAt);
        record("client.fetch", {
          method: self.__obs_method,
          url: self.__obs_url,
          status: this.status,
          durationMs,
          requestBodyPreview: previewBody(body ?? null),
          ok: this.status >= 200 && this.status < 400,
          transport: "xhr",
        });
      });
    }
    return originalXHRSend.call(this, body ?? null);
  };
}

function installClickHook(): void {
  document.addEventListener("click", (e: MouseEvent) => {
    const target = e.target as Element | null;
    if (!target) return;
    const interactive = target.closest("button, a, input, select, textarea, [role='button'], [role='link'], [role='tab']");
    record(interactive ? "client.click" : "client.click.background", {
      selector: selectorFor(interactive ?? target),
      text: visibleText(interactive ?? target),
      tag: (interactive ?? target).tagName.toLowerCase(),
      role: (interactive ?? target).getAttribute("role") ?? undefined,
      href: (interactive instanceof HTMLAnchorElement) ? interactive.href : undefined,
      x: e.clientX,
      y: e.clientY,
    });
  }, true); // capture phase — get the event before app-level handlers stopPropagation
}

function installRouteHook(): void {
  const emit = (kind: "pushState" | "replaceState" | "popstate") => {
    record("client.route", {
      kind,
      url: location.href,
      pathname: location.pathname,
      search: location.search,
      hash: location.hash,
    });
  };
  history.pushState = function (data: unknown, unused: string, url?: string | URL | null) {
    const ret = originalPushState(data, unused, url ?? "");
    emit("pushState");
    return ret;
  };
  history.replaceState = function (data: unknown, unused: string, url?: string | URL | null) {
    const ret = originalReplaceState(data, unused, url ?? "");
    emit("replaceState");
    return ret;
  };
  window.addEventListener("popstate", () => emit("popstate"));
}

function installPerfHook(): void {
  if (typeof PerformanceObserver === "undefined") return;
  // LCP — last largest contentful paint observed before user interacts.
  try {
    const po = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        record("client.perf.lcp", {
          startTime: entry.startTime,
          // deno-lint-ignore no-explicit-any
          size: (entry as any).size,
          // deno-lint-ignore no-explicit-any
          url: (entry as any).url,
        });
      }
    });
    po.observe({ type: "largest-contentful-paint", buffered: true });
  } catch { /* unsupported — fine */ }
  // CLS — cumulative layout shift over the page lifetime; snapshot
  // each entry, the analytics product can sum at query time.
  try {
    const po = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        // deno-lint-ignore no-explicit-any
        const e = entry as any;
        if (e.hadRecentInput) continue; // ignore user-initiated shifts
        record("client.perf.cls", {
          startTime: entry.startTime,
          value: e.value,
        });
      }
    });
    po.observe({ type: "layout-shift", buffered: true });
  } catch { /* unsupported — fine */ }
  // INP — interaction to next paint. event-timing entries with
  // interactionId are user interactions; we record the worst per
  // batch flush.
  try {
    const po = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        // deno-lint-ignore no-explicit-any
        const e = entry as any;
        if (!e.interactionId) continue;
        record("client.perf.inp", {
          startTime: entry.startTime,
          duration: entry.duration,
          name: entry.name,
          interactionId: e.interactionId,
        });
      }
    });
    po.observe({ type: "event", buffered: true, durationThreshold: 16 });
  } catch { /* unsupported — fine */ }
}

function installSessionLifecycleHook(): void {
  record("client.session", { kind: "start", url: location.href, ua: navigator.userAgent });
  document.addEventListener("visibilitychange", () => {
    record("client.session", { kind: "visibility", visibilityState: document.visibilityState });
  });
  // pagehide is the only reliable "page is leaving" event in modern
  // browsers (beforeunload fires inconsistently, especially on
  // mobile). Flush the queue via sendBeacon before we lose the
  // chance.
  window.addEventListener("pagehide", () => {
    record("client.session", { kind: "pagehide" });
    flushSync();
  });
}

// ── Helpers ──────────────────────────────────────────────────────

function argsToSerializable(args: unknown[]): unknown[] {
  return args.map((a) => {
    if (a === null || a === undefined) return a;
    const t = typeof a;
    if (t === "string" || t === "number" || t === "boolean") return a;
    if (a instanceof Error) {
      return { __error: true, name: a.name, message: a.message, stack: a.stack };
    }
    try {
      // JSON.stringify handles cycles by throwing — we catch and
      // fall back to a string description so the event survives.
      JSON.stringify(a);
      return a;
    } catch {
      return String(a);
    }
  });
}

function previewBody(body: BodyInit | Document | null | undefined): string | undefined {
  if (body === null || body === undefined) return undefined;
  if (typeof body === "string") {
    return body.length > FETCH_BODY_PREVIEW_CAP
      ? body.slice(0, FETCH_BODY_PREVIEW_CAP) + "…[truncated]"
      : body;
  }
  if (body instanceof Blob) return `[Blob ${body.size}B type=${body.type}]`;
  if (body instanceof ArrayBuffer) return `[ArrayBuffer ${body.byteLength}B]`;
  if (body instanceof FormData) return "[FormData]";
  if (body instanceof URLSearchParams) return body.toString().slice(0, FETCH_BODY_PREVIEW_CAP);
  return "[unknown body type]";
}

async function peekResponseBody(res: Response): Promise<{ preview?: string; bytes?: number }> {
  const ct = res.headers.get("content-type") ?? "";
  const isText = /^(text\/|application\/(json|xml|javascript))/i.test(ct);
  if (!isText) {
    const len = res.headers.get("content-length");
    return { bytes: len ? Number(len) : undefined };
  }
  try {
    const clone = res.clone();
    const text = await clone.text();
    return {
      preview: text.length > RESPONSE_BODY_PREVIEW_CAP
        ? text.slice(0, RESPONSE_BODY_PREVIEW_CAP) + "…[truncated]"
        : text,
      bytes: text.length,
    };
  } catch {
    return {};
  }
}

function selectorFor(el: Element): string {
  // Lightweight selector: tag#id.cls or tag[role='x']. Skips the
  // full DOM-path walk a real test runner would do — analytics
  // consumers can pivot on tag/role/text and don't need
  // pixel-perfect xpath.
  const parts: string[] = [el.tagName.toLowerCase()];
  if (el.id) parts.push(`#${el.id}`);
  const cls = el.getAttribute("class");
  if (cls) {
    const trimmed = cls.trim().split(/\s+/).slice(0, 3);
    if (trimmed.length > 0) parts.push("." + trimmed.join("."));
  }
  return parts.join("");
}

function visibleText(el: Element): string {
  const t = (el as HTMLElement).innerText ?? el.textContent ?? "";
  const collapsed = t.replace(/\s+/g, " ").trim();
  return collapsed.length > 120 ? collapsed.slice(0, 120) + "…" : collapsed;
}

// ── Install once ─────────────────────────────────────────────────

let installed = false;

export function installBreadcrumbs(): void {
  if (installed) return;
  installed = true;
  // Production: caller checks env and skips. This guard is belt-and-
  // suspenders — even if installBreadcrumbs() is called in prod, the
  // server-side recordClientEvents is also gated, so nothing lands
  // in any JSONL file. Still skip the hooks to avoid the runtime
  // overhead of the wrappers.
  if (import.meta.env && import.meta.env.PROD) return;
  try {
    installConsoleHook();
    installErrorHooks();
    installFetchHook();
    installXHRHook();
    installClickHook();
    installRouteHook();
    installPerfHook();
    installSessionLifecycleHook();
  } catch (e) {
    originalConsole.warn.call(console, CONSOLE_OBS_PREFIX, "installation failed:", e);
  }
}
