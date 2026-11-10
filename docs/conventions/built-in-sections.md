# Built-in sections and public demos

## Built-in sections — `web/src/chipp-app.json` switches them

The base template ships five built-in sections: Inbound Email, Import, File
review, Docs and the end-user Portal. `web/src/chipp-app.json` says which ones
this app keeps:

```json
{ "version": 1, "modules": { "inboundEmail": false, "import": true, "fileReview": true, "docs": true, "portal": false } }
```

A section set to `false` loses its sidebar link and its routes
(`web/src/lib/app-modules.ts`; the Sidebar and `web/src/routes.ts` read it), so
its URLs fall to NotFound. A missing file or key keeps the section on.

The Chipp Builder writes this file when the person approves a plan: the
planner decides which sections the app needs. **To add or remove a built-in
section, edit `chipp-app.json`. Never hide one by editing the sidebar or the
route table.** The server routes stay mounted (cheap and inert when unused).

- **The flags are the Builder's choice.** Never flip a `chipp-app.json` flag,
  or put placeholder copy back in `landing/src/content/site.json`, to make a
  test pass: change the test (`src/__tests__/services/app-modules.test.ts`,
  `landing/scripts/placeholder-copy.mjs`) so it follows the choice.
- **The ticket that sets the product name fills every `site.json`
  placeholder** ("Your product", "X is a web app."), not only `name`.

## Public demos (`DEMO_MODE`)

Read `docs/demo-mode.md` before building a demo. A public demo never shares
one writable account or org across visitors and never grants admin: make it
read-only, or give each visitor a throwaway org of their own. Find the demo org
by an id the seed owns, never by a slug or name a visitor can claim.
