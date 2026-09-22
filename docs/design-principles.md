# Design principles for customising a project

This is the playbook the agent (and any human builder) uses when a user talks
about how their app should look. It exists because every project used to
ship looking exactly like the template. The mechanism that fixes that is the
design system in `web/src/design/`; this document is the judgement that
goes with it.

Read this when the user says anything about style, vibe, brand, fonts,
colours, "make it feel more X", or when starting a new project (the design
pass is step one, before any feature work).

## 1. The one file

`web/src/design/design.json` is the entire look: three fonts, five colours, a
radius family, a shadow style, a type scale and a density. Every component
reads tokens derived from it, so a change there re-skins the whole app. Never
change the look by editing a component or `app.css`; if a component cannot
express what the design needs, add a token, not a hard-coded value.

Start from a preset (`deno task design list`), then adjust one or two
things. A preset that has been nudged is still a coherent design; five
independent choices made from scratch usually are not.

## 2. Translate words into a preset

Match the user's language to a preset before touching individual values.
`deno task design match "<their words>"` (or `GET /api/dev/design?match=`)
ranks presets by vibe words. The nine presets and what they mean:

| Preset | Reach for it when they say | The move |
|---|---|---|
| `clean` | clean, simple, neutral, dashboard, undecided | Inter everywhere, indigo action, 8px radius. Content is the brand. |
| `modern` | tech, startup, sleek, AI, developer | Grotesk headings + geometric body, blue/violet, large radius. |
| `editorial` | magazine, publishing, newsletter, literary | Serif display on paper, brick action colour, small radius, no shadow. |
| `friendly` | fun, playful, warm, consumer, community, kids | Rounded humanist type, pill buttons, raspberry + sunny accent, spacious. |
| `corporate` | enterprise, bank, insurance, serious, compliance | One superfamily (Plex), conservative blue, hairlines, compact. |
| `luxury` | premium, elegant, boutique, calm, refined | Light serif at a 1.333 scale, black on ivory, gold accent, no radius. |
| `brutalist` | bold, raw, loud, agency, indie, y2k | Uppercase heavy grotesk, 2px borders, hard offset shadows, acid yellow. |
| `dark` | dark mode, console, terminal, gaming, neon | Blue-black canvas, wide headings, cyan action, violet accent. |
| `organic` | natural, earthy, wellness, food, craft, garden | Calligraphic serif + humanist body, sage and clay, large soft radii. |

When two presets match, ask one question that separates them ("closer to a
magazine or to a bank?") rather than listing options. When the user names a
specific brand, pick the closest preset and then set the primary colour to
theirs.

## 3. Typography

**Three fonts, three jobs.** Heading (primary voice), body (secondary, does
the reading), mono (tertiary, for code and numbers). The catalog in
`web/src/design/fonts.ts` is curated; any Google Fonts family works, but
catalog entries carry the weights the family actually ships, which the
Google CSS API requires.

**Pair by contrast of construction, or stay inside a superfamily.** A serif
heading over a sans body, or a geometric heading over a humanist body, reads
as intentional. Two similar sans faces read as a mistake. The zero-risk pairing
is a superfamily (IBM Plex, Source, DM, Geist) where heading, body and mono
share proportions. Google's own guidance: pairings work when the faces are
clearly different yet share underlying structure.

**Body weight is 400 or 500; heading weight is where the personality is.**
Light serifs (Cormorant at 500–600) read expensive; heavy grotesks (Archivo
Black, Sora 700) read loud. Do not pick a heading weight the family lacks; the
runtime snaps to the nearest, so `Lato` at 600 becomes 700.

**Scale.** 16px base, ratio 1.2 for dense products, 1.25 for marketing-ish
apps, 1.333 only when there is little running text (luxury, portfolios). Body
line-height 1.5, headings ~1.15. Sizes come from the scale; never invent a
size that is not on it.

**Tracking and case.** Tight negative tracking (-0.02em) suits grotesks at
large sizes; serifs and humanist faces want 0. Uppercase headings are a
statement (brutalist, sports, events), not a default.

## 4. Colour

**60/30/10.** The canvas (`background`) dominates. `surface` and `text` carry
structure. `primary` is reserved for the one thing the user should do on a
screen: primary buttons, links, focus rings, active nav. `accent` is rarer
still: badges, charts, a highlight. If the primary appears on every row, it
stops meaning "act here".

**Derive, do not pick, the small stuff.** Borders, muted text, hover states
and soft tints are computed from ink and canvas by `tokens.ts`, so they stay
right on any background, including dark. Only the five colours are decisions.

**Contrast is not optional.** WCAG 2.2 AA: 4.5:1 for text, 3:1 for large text
and for UI components (borders, focus rings, icons). The design page and
`deno task design check` enforce text-on-canvas and text-on-surface as hard
errors and warn on weak button labels or a primary that vanishes into the
canvas. Button label colour is chosen by contrast, which is why a yellow
primary gets a black label automatically.

**Warm or cool, not both.** Off-white canvases carry a temperature (paper is
warm, slate is cool); the primary and accent should share it. A warm paper
with an icy blue button looks like two designs.

**Dark mode is a design, not an inversion.** Every app has a user-facing
light/dark toggle (default light). A light design gets the template's
generic dark theme under that toggle; the `dark` preset is a product that is
dark by construction and stays dark in both. Do not flip a light design to
dark by swapping text and background; start from the preset.

## 5. Shape, depth, density

**One radius family.** `none` reads formal or brutal, `sm` reads serious,
`md` reads competent, `lg` reads friendly, `pill` reads playful. Mixing sharp
and rounded in one interface always looks worse than either alone. Pill
applies only to controls; cards keep a finite radius.

**Shadows say what the style is.** `soft` layered shadows are the default
product look. `none` is editorial, corporate and luxury. `hard` (solid offset)
is the defining move of neo-brutalism and should travel with 2px borders and
no radius; it looks wrong with anything else.

**Density follows the content.** Compact for tables and admin, comfortable
for most apps, spacious when whitespace is the point (luxury, wellness,
editorial). Spacing comes from one scale multiplied by the density.

## 6. Hierarchy comes from contrast, not colour

Work in grayscale first: size, weight and spacing should carry the hierarchy
before any colour is applied. Then add the primary where action is, the
accent where attention is. If a screen still reads correctly with the primary
turned grey, the colour is doing its job.

## 7. The conversation

1. Ask what the product is and who uses it, if you do not know. Category
   drives the preset more than adjectives do.
2. Propose one preset with a one-line reason. Apply it so they see it on the
   design page (`/#/design`) and on their real screens, not as a description.
3. Take their reaction as a delta ("warmer", "less round", "more serious") and
   change one axis at a time: fonts, then colour, then shape.
4. Check the design page's warnings before calling it done. A design with a
   contrast error is not done.
5. Save. The design is a file in the repo; it ships with the app and every
   later feature inherits it.

Do not present a swatch of four options for a bug fix, a value the user gave
you ("use Inter"), or a question with an obvious answer. Do present options
when the request is aesthetic and open ("make it feel more premium").

## Sources

- Google Fonts Knowledge: [Pairing typefaces](https://fonts.google.com/knowledge/choosing_type/pairing_typefaces), [Pairing within a family and superfamily](https://fonts.google.com/knowledge/choosing_type/pairing_typefaces_within_a_family_superfamily), [The font matrix](https://fonts.google.com/knowledge/choosing_type/pairing_typefaces_based_on_their_construction_using_the_font_matrix)
- Typewolf, [The 40 best Google Fonts](https://www.typewolf.com/google-fonts)
- W3C, [WCAG 2.2](https://www.w3.org/TR/WCAG22/) and [Understanding 1.4.11 Non-text Contrast](https://www.w3.org/WAI/WCAG21/Understanding/non-text-contrast.html)
- Carbon Design System, [Typography](https://v6.carbondesignsystem.com/essentials/typography.html); LogRocket, [Typographic scaling](https://blog.logrocket.com/ux-design/typographic-scaling/)
- LogRocket, [The 60-30-10 rule in UI design](https://blog.logrocket.com/ux-design/60-30-10-rule/); Nielsen Norman Group, [Using color to enhance your design](https://www.nngroup.com/articles/color-enhance-design/)
- Adam Wathan and Steve Schoger, *Refactoring UI* (constrained scales, hierarchy in grayscale, one radius family), via [this summary](https://www.sglavoie.com/posts/2023/09/09/book-summary-refactoring-ui/)
- Setproduct, [Retro and brutalist UI design: a 2026 field guide](https://www.setproduct.com/blog/retro-brutalist-ui-design-2026); Figma, [Web design trends 2026](https://www.figma.com/resource-library/web-design-trends/)
- Google Fonts, [CSS API v2](https://developers.google.com/fonts/docs/css2) (weight axes, `text=` subsetting)
