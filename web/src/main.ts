import { mount } from "svelte";
import App from "./App.svelte";
import "./app.css";

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

import { initDevPanel } from "./lib/devpanel/init";

initDevPanel();

const app = mount(App, {
  target: document.getElementById("app")!,
});

export default app;
