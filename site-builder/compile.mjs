import { createHash } from 'node:crypto';

export class SiteInputError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SiteInputError';
    this.code = code;
  }
}

const fail = (code, message) => { throw new SiteInputError(code, message); };
const text = (value, label, max = 2000) => {
  if (value == null) return '';
  if (typeof value !== 'string' || value.length > max) fail('INVALID_FIELD', label + ' must be a bounded string');
  return value.replace(/\s+/g, ' ').trim();
};
const slug = (value) => text(value, 'site_slug', 63).toLowerCase();
const safeSlug = (value) => slug(value).replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50);
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const date = (value, label) => {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT/.test(value) || Number.isNaN(Date.parse(value))) {
    fail('INVALID_DATE', label + ' must have an ISO capture timestamp');
  }
  return new Date(value).toISOString();
};
const publicUrl = (value, label) => {
  if (typeof value !== 'string' || value.length > 2048) fail('INVALID_URL', label + ' must be a URL');
  let url;
  try { url = new URL(value); } catch { fail('INVALID_URL', label + ' is not a URL'); }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || url.username || url.password || url.port ||
      !host.includes('.') || host === 'localhost' || host.endsWith('.local') ||
      host.endsWith('.internal') || /^\d+(\.\d+){3}$/.test(host) || host.includes(':')) {
    fail('INVALID_URL', label + ' must be a public HTTPS hostname');
  }
  url.hash = '';
  return url;
};
const hostname = (url) => url.hostname.toLowerCase().replace(/^www\./, '');
const desc = (value) => value.length > 165 ? value.slice(0, 162).replace(/\s+\S*$/, '') + '...' : value;
const boundedTitle = (value) => value.length > 62 ? value.slice(0, 59).replace(/\s+\S*$/, '') + '...' : value;
const article = (key, desk, title, deck, pageType, refs, sections, featured = false) => ({
  slug: key, desk, title: boundedTitle(title), deck: desc(deck), pageType,
  refs, sections, featured,
});
const websiteRef = (page, index) => 'website-' + (index + 1);
const knownText = (value) => value || 'Unknown; ask the supplier to confirm.';
const previewCTA = { label: 'Prepare an enquiry', action: 'request-quote', target: '/enquiry' };

export function compileEnterpriseSite(input) {
  if (!input || typeof input !== 'object' || input.schema_version !== '1.0.0') {
    fail('SCHEMA_VERSION', 'Expected EnterpriseSiteInput 1.0.0');
  }
  const siteSlug = slug(input.site_slug);
  if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(siteSlug) || siteSlug.includes('--')) {
    fail('INVALID_SITE_SLUG', 'site_slug must be a DNS-safe slug');
  }
  const enterprise = input.enterprise;
  if (!enterprise || typeof enterprise !== 'object' || !enterprise.company) {
    fail('ENTERPRISE_REQUIRED', 'A real enterprise company snapshot is required');
  }
  const enterpriseId = text(enterprise.id, 'enterprise.id', 120);
  const revision = enterprise.revision;
  if (!enterpriseId || !(typeof revision === 'string' || Number.isInteger(revision))) {
    fail('ENTERPRISE_REQUIRED', 'Enterprise id and revision are required');
  }
  const company = enterprise.company;
  const companyName = text(company.displayName || company.legalName, 'company.name', 120);
  const companyDescription = text(company.description, 'company.description', 3000);
  if (!companyName) fail('COMPANY_REQUIRED', 'The enterprise needs a company name');
  const website = publicUrl(company.website, 'company.website');
  const websitePages = input.website_pages;
  if (!Array.isArray(websitePages) || !websitePages.length || websitePages.length > 5) {
    fail('WEBSITE_CAPTURE_REQUIRED', 'One to five real website snapshots are required');
  }

  const evidence = [{
    evidence_id: 'enterprise-company',
    claim: 'Company name and enterprise description',
    value: companyDescription || companyName,
    status: 'supplier-stated', source_url: null, source_quote: null,
    captured_at: date(input.exported_at, 'exported_at'),
    publication_permission: 'internal-only',
    notes: 'Enterprise record; not independently verified',
  }];
  const acceptedPages = [];
  const seen = new Set();
  for (let index = 0; index < websitePages.length; index += 1) {
    const raw = websitePages[index];
    if (!raw || typeof raw !== 'object') fail('INVALID_SOURCE', 'Website snapshot is not an object');
    const source = publicUrl(raw.url, 'website_pages.url');
    if (hostname(source) !== hostname(website)) fail('CROSS_DOMAIN_SOURCE', 'Website source is not from the enterprise domain');
    if (seen.has(source.href)) fail('DUPLICATE_SOURCE', 'Duplicate website snapshot');
    seen.add(source.href);
    const body = text(raw.body_text, 'website_pages.body_text', 30000);
    if (body.length < 40) fail('EMPTY_SOURCE', 'Website snapshot must include a real readable text body');
    const sourceHash = sha256(Buffer.from(body, 'utf8'));
    if (raw.content_sha256 && raw.content_sha256 !== sourceHash) {
      fail('SOURCE_HASH_MISMATCH', 'Website text does not match recorded snapshot SHA-256');
    }
    const capturedAt = date(raw.captured_at, 'website_pages.captured_at');
    const title = text(raw.title, 'website_pages.title', 250) || 'Company website';
    const quote = body.slice(0, 220);
    const ref = websiteRef(raw, index);
    evidence.push({
      evidence_id: ref,
      claim: 'Website page: ' + title,
      value: quote,
      status: 'supplier-stated',
      source_url: source.href,
      source_quote: quote,
      captured_at: capturedAt,
      publication_permission: 'public-source-review-only',
      notes: 'Website text snapshot; supplied by collector, not independently verified',
    });
    acceptedPages.push({ url: source.href, title, body, ref, capturedAt, sha256: sourceHash });
  }

  const products = Array.isArray(enterprise.products) ? enterprise.products : [];
  if (products.length > 12) fail('TOO_MANY_PRODUCTS', 'Maximum 12 products per first edition');
  const validProducts = products.map((product, index) => {
    const name = text(product?.name, 'product.name', 180);
    if (!name) fail('INVALID_PRODUCT', 'Product record needs a name');
    const id = text(product.id, 'product.id', 120);
    if (!id) fail('INVALID_PRODUCT', 'Product record needs a stable ID');
    const description = text(product.description, 'product.description', 3000);
    const category = text(product.category, 'product.category', 140);
    const ref = 'enterprise-product-' + (index + 1);
    evidence.push({
      evidence_id: ref, claim: 'Enterprise product: ' + name,
      value: description || name, status: 'supplier-stated',
      source_url: null, source_quote: null,
      captured_at: date(input.exported_at, 'exported_at'),
      publication_permission: 'internal-only',
      notes: 'Enterprise library product ' + id + '; not an independently verified specification',
    });
    return { name, description, category, ref, slug: safeSlug(name) || 'product-' + (index + 1) };
  });
  const uniqueSlugs = new Set();
  for (const product of validProducts) {
    let current = product.slug; let suffix = 2;
    while (uniqueSlugs.has(current)) current = product.slug.slice(0, 42) + '-' + suffix++;
    uniqueSlugs.add(current); product.slug = current;
  }

  const supplierSlug = safeSlug(companyName) || 'supplier';
  const publicationName = boundedTitle(companyName + ' | Buyer Notes');
  const guideSlug = 'buyer-enquiry-guide';
  const description = desc('A source-backed buyer review of ' + companyName + '. Explore its stated product scope, website sources and the questions to confirm before requesting a quote.');
  const articles = [];
  const companyWeb = acceptedPages[0];
  articles.push(article(supplierSlug, 'suppliers', companyName + ': supplier profile',
    'Review the company record and public website statements before evaluating sourcing fit.',
    'supplier-profile', ['enterprise-company', companyWeb.ref], [
      ['What the company states', knownText(companyDescription)],
      ['Website source and qualification', 'The supplier website is ' + companyWeb.url + '. The visible source text is retained as evidence. Factory credentials, trading terms and production capacity are not independently verified.'],
    ], validProducts.length === 0));
  validProducts.forEach((product, index) => {
    const supporting = acceptedPages.filter((page) => page.body.toLowerCase().includes(product.name.toLowerCase()));
    const refs = [product.ref, ...supporting.map((page) => page.ref)];
    const body = product.description || 'No product description was supplied in the enterprise library.';
    articles.push(article(product.slug, 'products', product.name + ': buyer review',
      'A buyer-facing overview based on the enterprise product record. Commercial terms require direct confirmation.',
      'product-editorial', refs, [
        ['Product scope', body + ' The details above come from the supplier enterprise record, not an independent audit.'],
        ['Before requesting an offer', 'Confirm technical specifications, MOQ, unit pricing, sample availability, production lead time, certification documents and delivery terms. Unprovided values remain Unknown.'],
      ], index === 0));
  });
  articles.push(article(guideSlug, 'guides', 'Prepare a supplier enquiry',
    'A clear buying brief makes supplier comparison easier and reduces uncertainty around price, quantity and fulfilment.',
    'buyer-guide', [], [
      ['Start with a specification', 'Share the intended application, product reference, quantity and destination. Request a technical sheet and an approved sample where appropriate.'],
      ['Confirm the commercial terms', 'Ask the supplier to confirm MOQ, price and currency, payment terms, production lead time, quality controls and shipping terms in writing. No offer is implied by this review.'],
    ]));

  const pages = [
    { page_id: 'home', path: '/', page_type: 'home', locale: 'en',
      title: boundedTitle(publicationName + ': sourcing review'), description, h1: publicationName,
      intent: 'Evaluate supplier information and prepare a sourcing enquiry.',
      sections: [
        { type: 'answer', heading: 'Explore supplier evidence', body: 'Read the company profile, product notes and linked website sources.' },
        { type: 'process', heading: 'Before requesting a quote', body: 'Confirm missing commercial terms directly with the supplier.' },
      ], evidence_refs: ['enterprise-company', companyWeb.ref], primary_cta: previewCTA,
      indexable: false, noindex_reason: 'private-review' },
    ...articles.map((entry) => ({
      page_id: entry.slug, path: '/' + entry.desk + '/' + entry.slug + '/',
      page_type: entry.pageType, locale: 'en', title: entry.title, description: entry.deck,
      h1: entry.title, intent: 'Review supplier evidence before requesting a commercial offer.',
      sections: entry.sections.map(([heading, body]) => ({ type: 'editorial', heading, body })),
      evidence_refs: entry.refs, primary_cta: previewCTA, indexable: false,
      noindex_reason: 'private-review',
    })),
  ];
  const manifest = {
    schema_version: '1.0.0', site_slug: siteSlug,
    publication: { name: publicationName, kind: 'supplier-edition',
      primary_category: validProducts[0]?.category || 'Supplier sourcing',
      supplier_public_id: null, description },
    locale: 'en', base_url: 'https://buyer-magazine.invalid',
    routes: pages.map((page) => ({ path: page.path, page_id: page.page_id, page_type: page.page_type, indexable: false })),
    design_system: { direction: 'halftone', tokens_ref: 'src/styles/theme.css', motion: 'reduced' },
    assistant: { enabled: false, api_base_url: null, public_site_slug: siteSlug, features: [] },
  };
  const site = {
    slug: siteSlug, name: publicationName, description, url: manifest.base_url,
    locale: 'en', author: 'Buyer Notes editorial desk',
    supplierSlug, guideSlug, productName: validProducts[0]?.name || '',
    sourceWebsite: website.href, privatePreview: true,
  };
  const content = { site, manifest, pages, articles, evidence, sourceSnapshots: acceptedPages.map(({url, title, capturedAt, sha256}) => ({url, title, capturedAt, sha256})),
    preview_only: true, publication_blockers: [
      'EDITORIAL_APPROVAL_REQUIRED', 'MEDIA_RIGHTS_REQUIRED', 'CONVERSION_BACKEND_UNVERIFIED', 'PUBLIC_DEPLOYMENT_UNVERIFIED',
    ] };
  const fingerprint = sha256(JSON.stringify(content));
  return { ...content, fingerprint };
}
