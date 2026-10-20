/**
 * Agent tools entry point. Importing this module registers every agent
 * tool. Add an import here for each new tools file you write.
 */
import "@/services/agent-tools/starter-tools.ts";
// Support page tools. An empty stub in the base template; the app-support
// pack replaces it with the support_* tools when the feature is on.
import "@/services/support/agent-tools.ts";

export * from "@/services/agent-tools/registry.ts";
