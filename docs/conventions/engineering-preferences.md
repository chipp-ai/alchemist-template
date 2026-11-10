# Engineering preferences

## Engineering Preferences

These guide all code review and implementation decisions:

- **DRY is important** -- flag repetition aggressively. If you see the same logic in two places, call it out.
- **Well-tested code is non-negotiable.** Too many tests > too few tests.
- **"Engineered enough"** -- not under-engineered (fragile, hacky) and not over-engineered (premature abstraction, unnecessary complexity). Find the middle.
- **Handle real edge cases at system boundaries** (user input, external APIs, DB results) -- not phantom ones in internal code.
- **Bias toward explicit over clever.** If a reader has to pause and think about what the code does, it is too clever.
- **Never hand-roll regex / keyword heuristics to interpret natural language or judge fuzzy intent.** Deciding "did the user say yes?", "is this message a complaint / positive / spam?", "which category is this free text?", or extracting structured fields from prose is a MODEL job — call a small cheap model (Haiku-class, e.g. `claude-haiku-4-5`) with **structured outputs** (a forced tool call / JSON schema returning typed fields) and fail CLOSED on error. A keyword list or affirmative-word regex silently mis-reads negation, conditionals, and sarcasm — it passes review and breaks on real input. Regex/string-matching is ONLY for genuinely structured, syntactic input (validating an email/URL/UUID format, parsing a known grammar, matching a fixed enum you control). If a person typed it in their own words and you're inferring meaning, that's a model call.
