# Golden Reference — Material Notes

The default pilot edition, rebuilt as the v2 reference. Content is unchanged: three reviews and
six supplier-stated facts from three public Burel Factory pages, captured 18 November 2026. No
image is supplier photography; the three pictures are the existing, reviewed and labelled AI
concept studies (`src/data/concept-media.json`). No commercial relationship is stated or implied.

Screenshots: [`screens/golden-reference/`](screens/golden-reference/) — `<page>@<width>.fold.webp`
(first screen) and `.full.webp` (whole page) at 1440, 768, 390 and 360 px. Before:
[`screens/baseline/`](screens/baseline/). Page turn frames: [`screens/page-turn/`](screens/page-turn/).

Planner decision (reproduced at build from the pilot's own records): `editorial-prestige`,
split cover, product `split` with a `figures` ledger, supplier `split-reverse`, guide `text-led`.

| Page (folio) | Composition | What a buyer gets first |
| --- | --- | --- |
| `/` (01) | Serif masthead with "Sources checked 18 November 2026 · 6 source-stated facts from 3 public pages"; story column beside an uncovered picture; numbered contents; the lead's Fact Ledger; supplier portrait; questions; "How this edition is made" | What the edition is, how current it is, three ways in |
| `/materials/silver-wool-fabric/` (02) | Headline beside the picture; ledger with `100%` / `140 cm` / `800 g/m` set large, each with status, host and date, and four open boxes; body with a sticky "Your enquiry will carry" panel | The specification and its gaps in one view |
| `/suppliers/burel-factory/` (03) | Picture first, headline beside; balanced sparse ledger (one fact, four gaps) | Where the mill is, and what is not established |
| `/guides/burel-project-brief/` (04) | The buying question as a large headline; wide picture; questions to choose | The questions to put in an enquiry |
| `/sources/` (05) | Source notebook | Every fact with its source and date |
| `/enquiry/` | Form beside "What happens when you send": saved with a receipt → reviewed by the desk → not sent to a supplier; visit context behind a disclosure | What submitting does and does not do |

Every page has a running head (publication · section · `p. 02 / 05`), a foot with the previous
and next page, edge tabs on wide screens and arrow-key turning.

## Art director's review (not a test result)

Works: the ledger makes the honest gap visible and is the strongest visual on the page; the
picture is finally seen; the folio sequence gives the edition the shape of an issue; the turn is
quick (560 ms) and reads as paper, with the bar holding still as the binding.

Still weak, open:

1. The edition has three reviews. The cover, contents and folios make that thinness *visible*;
   that is honest, but a real issue needs more pieces before it reads as a magazine.
2. The guide and the source notebook still use pre-v2 list styling below the hero.
3. Caption and credit repeat "AI-generated" on every picture (both fields are required records).
4. The paper grain is a screen effect; it should be judged on a calibrated display, and in dark
   mode it is deliberately faint.
5. Mobile turns are the same 3D turn; a swipe gesture was not added (it would conflict with
   horizontal scrolling of the desk bar and of tables).
