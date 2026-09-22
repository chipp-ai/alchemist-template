/**
 * Job module entry point.
 *
 * Importing this file registers every handler under ./handlers/ (each
 * file calls defineJob at module load) and re-exports the runner. Add a
 * new handler by creating the file AND adding its import here, exactly
 * like store registration in web/src/main.ts.
 */

import "./handlers/org-digest.ts";

export {
  isJobRunnerRunning,
  jobsEnabled,
  runJobsTick,
  startJobRunner,
  stopJobRunner,
} from "./runner.ts";
export { defineJob, listJobKinds } from "./registry.ts";
