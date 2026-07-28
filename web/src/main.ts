import { mount } from "svelte";
import App from "./App.svelte";
import "./app.css";
import { installBreadcrumbs } from "./lib/observability/breadcrumbs";

// Install observability hooks BEFORE store init / DevPanel / app
// mount so the rest of bootup is captured in the JSONL stream.
// No-op in production via the installer's own import.meta.env.PROD
// gate. See web/src/lib/observability/breadcrumbs.ts and
// src/observability/envelope.ts.
installBreadcrumbs();

// Eagerly import every store module so each module's `defineStore()`
// call runs before `initDevPanel()` wires the push pipeline. New
// stores added by the agent should be added here — pattern documented
// in CLAUDE.md → "Stores and the DevPanel".
//
// Imports are bare (we don't use the exported bindings directly here);
// the top-level `defineStore` call inside each module is the side
// effect that registers it.
import "./stores/auth.svelte";
import "./stores/organization.svelte";
import "./stores/sessionTimeout.svelte";
import "./stores/billing.svelte";
import "./stores/toast.svelte";

import { initDevPanel } from "./lib/devpanel/init";

initDevPanel();

const app = mount(App, {
  target: document.getElementById("app")!,
});

export default app;
