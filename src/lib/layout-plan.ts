// The layout plan the pages render from. An enterprise edition ships layout-plan.json, which is
// validated here (and replanned by scripts/validate-content.mjs). The pilot edition is planned
// by the same planner from its own records, so the Golden Reference is a planner decision too.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  layoutInputsFromPack,
  planEditionLayout,
  validateLayoutPlan,
} from '../../site-builder/layout-planner.mjs';
import pilot from '../data/pilot.json';
import concepts from '../data/concept-media.json';
import pilotEvidence from '../data/evidence.json';
import { site } from '../config';

export type HeroLayout = 'split' | 'split-reverse' | 'text-led' | 'marginal';
export type HomeBlock = 'index' | 'lead-ledger' | 'supplier' | 'products' | 'catalog' | 'questions' | 'reading' | 'trust';
export interface LayoutPlan {
  schema_version: string;
  design_family: string;
  signals: Record<string, number | string>;
  rationale: string[];
  home: { cover: 'split' | 'immersive' | 'typographic'; blocks: HomeBlock[]; show_media: boolean };
  pages: Record<string, { hero: HeroLayout; ledger: 'figures' | 'table'; show_media: boolean }>;
  plan_sha256: string;
}

let cached: LayoutPlan | null = null;
export function loadLayoutPlan(): LayoutPlan {
  if (cached) return cached;
  const edition = process.env.BUYERSITE_BUILD_ROOT;
  if (edition) {
    const pages = JSON.parse(readFileSync(resolve(edition, 'pages.json'), 'utf8')) as { page_id: string; page_type: string }[];
    cached = validateLayoutPlan(
      JSON.parse(readFileSync(resolve(edition, 'layout-plan.json'), 'utf8')),
      pages.filter((page) => page.page_type !== 'home').map((page) => page.page_id),
    ) as LayoutPlan;
    return cached;
  }
  const pages = pilot.articles.map((article) => ({
    page_id: article.slug,
    page_type: article.type,
    evidence_refs: article.refs,
  }));
  const mediaReport = {
    images: concepts.assets.map((asset) => ({
      page_id: asset.page_id,
      kind: asset.kind,
      review_decision: asset.review?.decision,
    })),
  };
  cached = validateLayoutPlan(
    planEditionLayout(
      layoutInputsFromPack({
        pages,
        evidence: pilotEvidence,
        mediaReport,
        site: { name: site.name, designDirection: site.designDirection },
        visualPlan: { direction: site.designDirection },
      }),
    ),
    pages.map((page) => page.page_id),
  ) as LayoutPlan;
  return cached;
}

export const pagePlan = (pageId: string) => loadLayoutPlan().pages[pageId] ?? null;
