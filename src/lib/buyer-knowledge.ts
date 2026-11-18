import { site } from '../config';
import { loadBuyerBriefs } from './buyer-brief';
import { loadEvidence } from './evidence';
import concepts from '../data/concept-media.json';
import { buildPublicKnowledge, structuredSubjects } from '../../scripts/public-knowledge.mjs';

export function loadBuyerKnowledge() {
  const briefs = loadBuyerBriefs();
  return buildPublicKnowledge({
    siteSlug: site.slug, name: site.name, origin: site.url,
    briefs, evidence: loadEvidence(), privatePreview: site.privatePreview,
    images: site.builderMode ? [] : concepts.assets.map((asset) => ({
      page_path: briefs.find((brief) => brief.page_path.replace(/\/$/, '').endsWith('/' + asset.page_id))?.page_path ?? '/',
      kind: asset.kind, caption: asset.caption, credit: asset.credit, sha256: asset.sha256,
    })),
  });
}

export function buyerStructuredData(pagePath: string) {
  return structuredSubjects(loadBuyerKnowledge(), pagePath);
}
