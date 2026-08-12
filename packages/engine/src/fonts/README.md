# Self-hosted webfonts

Ten WOFF2 files (five families × two subsets) plus `fonts.css`, the
`@font-face` stylesheet that loads them. Four families are the ones the theme
presets name; JetBrains Mono is the console's monospace face. This replaced
both the funnel runtime's Google Fonts requests and the console's own hotlink
— see PHASE-1-PLAN.md §4.9 for why.

`fonts.css` is linked from two places, and both are needed: the funnel page
shell (`apps/runtime/lib/html.js`) and the console shell
(`apps/app/index.html`). Both reach it through `/_of/fonts/fonts.css`, so
there is one copy and one cache entry.

| Family | Axis (variable `font-weight`) |
| --- | --- |
| Plus Jakarta Sans | 200–800 |
| Inter | 100–900 |
| Space Grotesk | 300–700 |
| Playfair Display | 400–900 |
| JetBrains Mono | 100–800 |

The axis is the family's real one, not a wish list. `styles.css` asks for
weights up to 850, which is past the top of Space Grotesk (700) and Plus
Jakarta Sans (800) — a variable font clamps to its own axis, so those elements
render at the family's heaviest weight rather than falling back to a system
face. That is the same result the old Google request produced (it asked every
family for `wght@…800` and got back whatever existed), so nothing regressed
here; it is written down because "the heading looks less bold than the CSS
says" has an answer, and the answer is not a bug.

Subsets: `latin` and `latin-ext` only, for every family — `latin` covers
German copy, `latin-ext` covers the Turkish/Polish surnames a German lead
form routinely captures. No other subset (vietnamese, cyrillic, greek, …) is
kept; they cost nothing at runtime either way since `unicode-range` gates the
download, but keeping the files would be pure repo weight for a case nobody
has.

Fetched 2026-08-12, from Google Fonts' css2 API. License: SIL Open Font
License 1.1 for all five families — see `OFL.txt` in this directory, which
also lists where each family's own copyright notice comes from.

## Regenerating

```
bun run scripts/fetch-fonts.mjs
```

Re-downloads all ten WOFF2 files and rewrites `fonts.css` from Google's
current css2 response. Run by hand only — nothing in the build or request
path calls this script, because there is no build step (see the invariant in
the repo's `CLAUDE.md`) and these files are committed output, not a runtime
dependency.

## Why they live here and not somewhere tidier

`vercel.json`'s `includeFiles` already covers `packages/engine/src/**`. That
is the only reason this directory is under the engine rather than a
top-level `fonts/` — moving these files anywhere else means they simply
don't ship to the deployed function, and the 404 only shows up in
production, not locally.
