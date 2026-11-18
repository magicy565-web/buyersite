import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import pilotBriefs from '../data/buyer-briefs.json' with { type: 'json' };
import pilotArticles from '../data/pilot.json' with { type: 'json' };
import pilotEvidence from '../data/evidence.json' with { type: 'json' };

export interface BuyerBrief {
  page_path: string;
  title: string;
  product_name: string;
  product_id: string | null;
  supplier_id: string | null;
  source_url: string | null;
  evidence_ids: string[];
  unconfirmed: { id: string; label: string; detail: string }[];
  questions: { id: string; label: string; prompt: string }[];
  summary: string;
}

interface PageContract {
  path: string;
  page_type: string;
  title: string;
  description?: string;
  evidence_refs?: string[];
  product_public_id?: string | null;
  supplier_public_id?: string | null;
}
interface EvidenceRecord {
  evidence_id: string;
  claim: string;
  value: string;
  source_url: string | null;
}

// Only local canonical article paths identify a brief. URLs and query strings
// never supply product names, supplier IDs or source links.
const pathKey = (path: string): string | null => {
  if (typeof path !== 'string' || !/^\/[a-z0-9-]+\/[a-z0-9-]+\/?$/.test(path)) return null;
  return path.replace(/\/$/, '');
};
const readJson = <T,>(path: string): T => JSON.parse(readFileSync(path, 'utf8')) as T;
const publicId = (value: unknown) => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,119}$/.test(value) ? value : null;
const sourceUrl = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : null;
  } catch { return null; }
};

function validateBrief(brief: BuyerBrief, evidence: EvidenceRecord[]): BuyerBrief {
  if (!pathKey(brief.page_path) || !brief.title || !brief.summary) throw new Error('Invalid buyer brief identity');
  const known = new Set(evidence.map((item) => item.evidence_id));
  if (brief.evidence_ids.some((id) => !known.has(id))) throw new Error('Buyer brief references missing evidence');
  for (const list of [brief.unconfirmed, brief.questions]) {
    const seen = new Set<string>();
    for (const item of list) {
      if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(item.id) || seen.has(item.id) || !item.label) throw new Error('Invalid buyer brief question or condition');
      seen.add(item.id);
    }
  }
  return brief;
}

function defaultConditions(pageType: string): BuyerBrief['unconfirmed'] {
  if (pageType === 'supplier-profile') return [
    { id: 'qualification', label: 'Supplier qualification', detail: 'The source material does not establish an independent factory audit or an approved trading relationship.' },
    { id: 'capability', label: 'Capacity and project capability', detail: 'Confirm the processes, capacity and delivery schedule relevant to your project.' },
    { id: 'quality', label: 'Product-specific evidence', detail: 'Request applicable technical sheets, samples and current quality documents.' },
    { id: 'commercial-terms', label: 'Commercial terms', detail: 'A current written offer is needed for minimum order, pricing, payment and delivery.' },
  ];
  return [
    { id: 'specification', label: 'Complete specification', detail: 'Confirm the intended use, product configuration and required technical documents.' },
    { id: 'minimum-price', label: 'Minimum order and price', detail: 'Order minimum, trade price and currency are not established by this review.' },
    { id: 'samples', label: 'Sample and quality approval', detail: 'Ask about sample availability, charges and how the final specification will be approved.' },
    { id: 'delivery', label: 'Availability and delivery', detail: 'Confirm stock or production time, packing and shipping terms for your destination.' },
  ];
}

function defaultQuestions(pageType: string): BuyerBrief['questions'] {
  return [
    { id: 'specification', label: pageType === 'supplier-profile' ? 'Check project capability' : 'Confirm the specification', prompt: 'Please confirm whether the product and intended use in our brief can be supported, and share the current technical sheet and any relevant qualification documents.' },
    { id: 'sample', label: 'Agree a sample and approval step', prompt: 'Please confirm sample availability and any charges, and explain how we can approve the specification, quality and finish before ordering.' },
    { id: 'written-offer', label: 'Request a comparable written offer', prompt: 'Please confirm the minimum order, price and currency, payment terms, availability or production time, packing and delivery terms for our quantity and destination.' },
  ];
}

/** Build-time public context only. Enterprise editions never fall back to pilot data. */
export function loadBuyerBriefs(): BuyerBrief[] {
  const edition = process.env.BUYERSITE_BUILD_ROOT;
  if (!edition) {
    const pagesPath = resolve('.generated/pages.json');
    const pages = existsSync(pagesPath) ? readJson<PageContract[]>(pagesPath) : pilotArticles.articles.map((article) => ({
      path: '/' + article.desk + '/' + article.slug + '/', title: article.title, page_type: article.type, evidence_refs: article.refs,
    }));
    return (pilotBriefs as BuyerBrief[]).map((brief) => {
      const page = pages.find((candidate) => pathKey(candidate.path) === pathKey(brief.page_path));
      if (!page) throw new Error('Buyer brief has no published page contract: ' + brief.page_path);
      return validateBrief({ ...brief, page_path: page.path, title: page.title, evidence_ids: [...(page.evidence_refs ?? brief.evidence_ids)] }, pilotEvidence);
    });
  }
  const pages = readJson<PageContract[]>(resolve(edition, 'pages.json'));
  const evidence = readJson<EvidenceRecord[]>(resolve(edition, 'evidence.json'));
  const editionSite = readJson<{ sourceWebsite?: string }>(resolve(edition, 'site.json'));
  const manifest = readJson<{ publication?: { supplier_public_id?: string } }>(resolve(edition, 'manifest.json'));
  return pages.filter((page) => ['product-editorial', 'supplier-profile', 'buyer-guide'].includes(page.page_type)).map((page) => {
    const refs = page.evidence_refs ?? [];
    const records = refs.map((id) => evidence.find((item) => item.evidence_id === id)).filter((item): item is EvidenceRecord => Boolean(item));
    const product = records.find((record) => record.claim.startsWith('Enterprise product: '));
    return validateBrief({
      page_path: page.path,
      title: page.title,
      product_name: page.page_type === 'product-editorial' ? product?.claim.slice('Enterprise product: '.length) ?? page.title.replace(/: buyer review$/, '') : '',
      product_id: page.page_type === 'product-editorial' ? publicId(page.product_public_id) : null,
      supplier_id: publicId(page.supplier_public_id ?? manifest.publication?.supplier_public_id),
      source_url: sourceUrl(records.find((record) => record.source_url)?.source_url) ?? sourceUrl(editionSite.sourceWebsite),
      evidence_ids: refs,
      summary: page.page_type === 'supplier-profile'
        ? 'Review the company information and source statements, then confirm capability, qualification and terms for your project.'
        : page.page_type === 'buyer-guide'
          ? 'Bring the intended use, product reference, quantity and destination into one brief, then compare written offers on the same basis.'
          : 'The information below comes from the supplier record and cited sources. Confirm the complete specification and a written offer for your requirements.',
      unconfirmed: defaultConditions(page.page_type),
      questions: defaultQuestions(page.page_type),
    }, evidence);
  });
}

export function getBuyerBrief(pagePath: string): BuyerBrief | null {
  const key = pathKey(pagePath);
  return key ? loadBuyerBriefs().find((brief) => pathKey(brief.page_path) === key) ?? null : null;
}

/** The only context passed in a CTA is a validated article path and question ID. */
export function buyerEnquiryHref(brief: BuyerBrief | null | undefined, questionId?: string): string {
  if (!brief) return '/enquiry';
  const query = new URLSearchParams({ from: brief.page_path });
  if (questionId && brief.questions.some((question) => question.id === questionId)) query.set('question', questionId);
  return '/enquiry?' + query.toString();
}
