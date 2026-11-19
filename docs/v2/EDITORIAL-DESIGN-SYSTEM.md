# Editorial design system v2

Design principle: **a buyer's review should look exactly as certain as its evidence.** Hierarchy
comes from scale contrast (serif masthead and headlines against small mono source tags), from the
**Fact Ledger** (what a source states, set large; what it does not state, set beside it as open
boxes of equal weight), and from print furniture (paper, running heads, folios, page turns).

## What changed from Halftone, and why

| Halftone rule | v2 | Reason |
| --- | --- | --- |
| Type set on the photograph behind a 92 % scrim | Pictures shown uncovered; type on paper beside or below | The scrim hid the only picture the edition has (D1). A buyer must see the material |
| The plate is the hierarchy | The Fact Ledger is the hierarchy | For a sourcing review, the known/unknown split is the content |
| One display face for all editions | Display face is a *family* decision (serif for editorial families, grotesque for dossier/catalogue) | A technical edition should read as a reference document |
| No shadows/gradients | Still none on components; paper grain and the fore-edge are print simulation, not UI decoration | Requested: the feel of paper and turning pages |
| Three directions = palettes | Three palettes kept (contrast-checked) **plus** five layout families that change structure | Palettes alone produced re-skins (D7, D8) |

Kept from Halftone: `--radius: 0`, rules not cards, one spot colour, mono kickers, one text
measure, self-hosted fonts, no client framework for layout, the 360 px floor.

## Blocks (`src/components/magazine/`)

| Block | Purpose | Variants |
| --- | --- | --- |
| `Cover` | Masthead (the page's only H1) + lead story | `split` (picture uncovered beside the story), `immersive` (full-bleed picture, story on a solid panel), `typographic` (no picture) |
| `EditionIndex` | Contents: numbered reading paths | — |
| `FactLedger` | Known vs to-confirm, each fact with status, source host and capture date | `figures` (measured values set large), `table` (long or many values); auto `sparse` balance for one fact |
| `SupplierPortrait` | Supplier facts + "what this profile does not establish" | with / without media |
| `CatalogIndex` | Many products as one comparable table (stated / to confirm counts) | collapses to records ≤ 48 rem |
| `TrustColophon` | How the edition is made: sources, pictures, enquiry, independence | — |
| `PageTurn` | Running head with folio, foot with previous/next page, edge tabs, arrow keys | head / foot |
| Article hero (`[slug].astro`) | Headline, standfirst, picture | `split`, `split-reverse`, `text-led`, `marginal` |

Values are never rewritten for display: `splitFigure()` splits `800 g/m (source notation…)` into a
large `800 g/m` and the rest, and `head + tail` is always the exact stored value.

## Layout families (`site-builder/layout-planner.mjs`)

The planner reads measurable signals and picks a family; the family decides block order and
compositions. A palette (`atelier` / `industrial` / `editorial`) is chosen independently by the
existing category visual director.

| Family | Chosen when | Cover | Home order | Article hero |
| --- | --- | --- | --- | --- |
| `editorial-prestige` | 1–3 products, reviewed media strength ≥ 2 | split | index → ledger → supplier → products → questions → trust | split / split-reverse / text-led |
| `editorial-journal` | 1–3 products, only abstract artwork | typographic | index → ledger → products → supplier → questions → trust | marginal |
| `technical-dossier` | industrial category, or ≥ 60 % numeric facts **and** ≥ 6 facts per product | typographic | **ledger first** → index → products → supplier → questions → trust | text-led / marginal; grotesque display |
| `catalog-index` | ≥ 4 products | split if media strong, else typographic | **catalogue table** → supplier → questions → trust | marginal; grotesque display |
| `sparse-brief` | no products | typographic | **company ledger** → questions → index → trust | marginal |

Media strength: licensed photo 3, reviewed AI concept 2, abstract fallback 0. Abstract fallbacks
never lead a cover or a page; they stay on the article as a small captioned `marginal` figure,
because the provenance label is part of the record and the browser suite checks the binding.

## Paper and the page turn (`src/styles/pageturn.css`)

- Paper grain: inline SVG `feTurbulence`, multiplied at 16 % (screen at 10 % in dark mode). No
  image request. Text contrast is computed against the flat tokens; grain only darkens paper.
- Fore-edge: hairlines at the right edge (≥ 80 rem) — the block of pages still to turn.
- Folios: `src/lib/sequence.ts` orders the edition (cover, products, supplier, guide, source
  notebook). Running head and foot read the same list.
- Turn: cross-document View Transitions. Forward, the page lifts and turns about the left spine
  (`rotateY(0 → -92deg)`, darkening) over the next page; back reverses. The header bar is the
  binding (`view-transition-name: binding`) and does not turn. Direction is set in an inline
  `<head>` script on `pagereveal` (a deferred module misses the event). Arrow keys turn pages
  unless focus is in a field, a dialog is open or a modifier is held.
- Fallbacks: `prefers-reduced-motion` → no transition; no View Transitions support or no JS →
  ordinary links. Nothing is hidden behind the interaction.
