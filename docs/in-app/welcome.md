# Welcome to your in-app docs

This is the in-app documentation section. The pages here are written as plain
markdown files under `docs/in-app/` in your project repo and registered in
`src/services/docs/registry.ts`. They ship inside your deployed app and render
under `/docs` for any signed-in team member.

## How it works

- **Write docs as markdown.** Add a `.md` file under `docs/in-app/` and register
  it in the docs registry. The page body is a live read of that file, so editing
  the markdown and redeploying updates the page. No copy to keep in sync.
- **Search is semantic.** Every page is split into heading sections, embedded,
  and indexed. A search matches on meaning, not just exact words, so you can find
  the right section even when your wording differs from the doc's.
- **The index reindexes itself.** On each app boot the indexer re-embeds only the
  sections whose content changed (it hashes each chunk), so the index stays fresh
  across deploys without any manual step.

## Why your project's AI agent benefits too

The same `docs/**` markdown that powers this section is the corpus your project's
conversational agent reads. Keeping product knowledge here means both your team
and the agent work from one source of truth.
