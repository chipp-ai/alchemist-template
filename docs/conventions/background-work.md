# Background work

## Background work must be gated on `WORKER_ROLE`

The platform can run this image as TWO pods from the same build when the
project declares a `worker:` block in `.alchemist/deployment.yaml`: the pod
serving traffic gets `WORKER_ROLE=api`, a sibling gets `WORKER_ROLE=worker`.

**Any periodic loop, queue drain, or boot-time job you add to `main.ts` must sit
inside `if (runsBackgroundWork)`.** Without it the work runs in BOTH pods and
every tick happens twice.

```ts
// main.ts already resolves this near the top:
const runsBackgroundWork = roleRunsBackgroundWork(); // src/lib/worker-role.ts

if (runsBackgroundWork) {
  startMyNewLoop();
}
```

Three things about the contract that are easy to get wrong:

- **An absent `WORKER_ROLE` runs background work** (`getWorkerRole()` returns
  `"all"`). That fail-open default is the important half: a project that never
  declared a worker runs one pod with no such env var and must keep doing its
  work. Defaulting to `"api"` would silently stop every loop with nothing
  erroring.
- **HTTP is NOT gated.** Both roles serve. The worker pod has its own readiness
  probe, and a worker that refused to serve `/health` would never become Ready.
- **Idempotent is not the same as free.** The inbound-email reaper claims rows
  safely, so a duplicate tick corrupts nothing, but it re-pays for the LLM
  extraction on every tick in every extra pod. `reindexDocs()` re-embeds changed
  chunks, so a second pod pays for the same embeddings again.

`src/__tests__/worker-role.test.ts` pins the resolution truth table (including
the fail-open default and typo handling) and asserts every background starter in
`main.ts` is inside the gate, so adding an ungated loop fails the suite.
