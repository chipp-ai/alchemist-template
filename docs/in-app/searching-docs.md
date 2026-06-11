# Searching the docs

The docs section has a search box at the top. Type a question or a few keywords
and it returns the most relevant sections across every page, ranked by meaning.

## Semantic vs keyword

Search is **semantic**: your query is embedded into the same vector space as the
docs, and results are ranked by similarity. That means a search for "how do I let
a teammate in" will surface the invites page even if it never uses the word
"let." When embeddings are unavailable (for example in local dev without the LLM
proxy configured), search falls back to a plain keyword match so it still works.

## What gets indexed

Each page is split into sections by its markdown headings. Long sections are
sub-split so a result points you at a focused passage rather than a whole page.
Each result shows the page title, the section heading, a snippet, and a relevance
score, and links straight to the page.

## Keeping results fresh

You do not reindex manually. When the app boots, the indexer compares a hash of
each section's text against what is already indexed and re-embeds only what
changed. Adding, editing, or removing a doc updates the index on the next deploy.
