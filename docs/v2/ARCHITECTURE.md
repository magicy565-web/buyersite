# Buyer Publishing Engine v2 — architecture

Built *after* the Golden Reference worked, from what it needed. One repository, one renderer,
no new services. Arrows are call direction.

```
enterprise export / pilot data
   │
   ▼
site-builder/compile.mjs ───────► evidence.json, pages.json, articles/*.md    (Service: deterministic)
   │                                  │
   ├─ visual-director.mjs ──► palette (atelier | industrial | editorial)      (Service)
   ├─ media-policy/render/review ──► media-report.json (rights, SHA, labels)   (Service, fail-closed)
   └─ layout-planner.mjs ──► layout-plan.json (family, blocks, heroes)        (Service, NEW)
                                      │
scripts/validate-content.mjs ◄────────┘ re-plans from the pack; LAYOUT_PLAN_DRIFT on mismatch
   │
   ▼
Astro: src/lib/layout-plan.ts ─► index.astro, [desk]/[slug].astro ─► components/magazine/*
   │                              (whitelisted blocks only; no model HTML/CSS)
   ▼
verify-output → browser suite → capture-screens → check-page-turn → release gate (unchanged)
```

## Skill / Service / Tool / Contract

| Kind | Item | Decision |
| --- | --- | --- |
| **Contract** | `layout-plan.json` v2.0.0 ([schema](schemas/layout-plan.schema.json)) | New. Family, signals, rationale, home blocks, per-page hero/ledger, `plan_sha256` |
| Contract | `evidence.json`, `pages.json`, `media-report.json`, `review.json`, `publication.json` | Unchanged. The renderer still only references `evidence_id` and bound local assets |
| **Service** | `planEditionLayout()` | New, pure, deterministic. Reads only signals (product count, facts per product, numeric share, media strength, name length, palette) |
| Service | `validateLayoutPlan()` | New. Fail-closed whitelist + hash check; used by the renderer and `validate-content` |
| Service | release gate, media rights, enquiry gateway | Unchanged except the Windows path fixes |
| **Skill** (future, model) | `visual-art-director` | May *propose* a plan. Must emit the same contract, pass `validateLayoutPlan()`, and may only cite the recorded signals. Never final on rights, evidence or release |
| Skill (future) | `visual-critic` | Reads `capture-screens` output (four widths) and returns findings; never sets `review.json` to pass by itself |
| **Tool/MCP** | image model, OpenMausBot, Cloudflare | Unchanged adapters. Not touched in this branch |

## Why a deterministic planner first, not a model

The blueprint proposed a model-driven Visual Director. A deterministic planner was built first
because (1) every decision it makes is reproducible and re-checkable at build time, (2) the
families needed real fixtures and screenshots to be defined — a model needs that same contract
to be useful, and (3) no model credentials or budget are authorised here. The contract is the
seam: a model proposal becomes one more producer of `layout-plan.json`, validated the same way.

## Reuse decisions

| Existing | Decision |
| --- | --- |
| `EditionCover`, `SupplierFeature`, `SpecSummary` | Superseded by `Cover`, `SupplierPortrait`, `FactLedger` on the home and article pages; left in the tree, unused, for one release |
| `ProductStory`, `BuyingChecklist`, `Evidence`, `Rail` | Reused; `ProductStory` gains `media` from the plan |
| `visual-director.mjs` palettes | Kept as palette selection only |
| `.grid article` rules in `theme.css` | Dead (D7); not removed in this branch, flagged for removal after the next review |
