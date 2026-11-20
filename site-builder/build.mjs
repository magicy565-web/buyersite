import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { compileEnterpriseSite } from './compile.mjs';
import { planMagazineOutline } from './magazine-outline.mjs';
import { planEditorialVisuals } from './visual-director.mjs';
import { planMedia } from './media-policy.mjs';
import { compileMagazineIssueFromEnterprise, assertIssueMediaFiles } from '../src/magazine/issue-from-enterprise.mjs';
import { assertMagazineIssue } from '../src/magazine/issue-contract.mjs';
import { materializeEditionMedia } from './media-render.mjs';
import { applyEditorialDraft, assertArtDirection } from '../editorial-department/artifact-contract.mjs';

const json = (value) => JSON.stringify(value, null, 2) + '\n';
const inline = (value) => JSON.stringify(value);
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const unique = (items) => [...new Set(items)];
const markdown = (value) =>
  String(value)
    .replace(/\\/g, '\\\\')
    .replace(/[<>&]/g, (char) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[char])
    .replace(/([\x60*_{}\[\]()#+.!|])/g, '\\$1');
const heading = (value) => markdown(value).replace(/^\\/, '');

export function articleMarkdown(entry, dateString, media) {
  const props = [
    ['title', entry.title],
    ['deck', entry.deck],
    ['desk', entry.desk],
    ['byline', ['editorial']],
    ['date', dateString],
    ['hero', './hero-' + entry.slug + '.png'],
    ['heroAlt', media.alt],
    ['heroCaption', media.caption],
    ['heroCredit', media.credit],
    ['format', entry.pageType === 'supplier-profile' ? 'photoessay' : entry.pageType === 'buyer-guide' ? 'brief' : 'report'],
    ['featured', Boolean(entry.featured)],
    ['evidenceRefs', entry.refs],
    ['pageType', entry.pageType],
  ];
  return (
    '---\n' +
    props.map(([key, value]) => key + ': ' + inline(value)).join('\n') +
    '\n---\n\n' +
    entry.sections
      .map(([title, body]) => '## ' + heading(title) + '\n\n' + markdown(body))
      .join('\n\n') +
    '\n'
  );
}

export async function writeSitePreview(input, baseDir = '.generated/company-sites', options = {}) {
  let result = compileEnterpriseSite(input);
  if (options.editorialDraft) result = applyEditorialDraft(result, options.editorialDraft);
  const artDirection = options.artDirection ? assertArtDirection(options.artDirection, result) : null;
  result.visualPlan = planEditorialVisuals({
    companyName: result.site.name,
    categories: result.articles.map((article) => article.category).filter(Boolean),
    articles: result.articles,
  });
  if(artDirection) result.visualPlan.art_direction=artDirection.visualDNA;
  result.mediaPlan = planMedia(result.articles, input.media_assets || []);
  const renderPolicy = {
    aiGenerationAuthorized: options.aiGenerationAuthorized === true,
    imageModel: options.imageModel || process.env.BUYERSITE_IMAGE_MODEL || 'gpt-image-2',
    maxAiImages: options.maxAiImages ?? 4,
    imageProviderConfigured: Boolean(Object.hasOwn(options,'apiKey') ? options.apiKey : process.env.OPENAI_API_KEY),
  };
  result.fingerprint = createHash('sha256').update(JSON.stringify({
    content: result.fingerprint,
    renderPolicy,
    artDirectionSha256: artDirection ? hash(artDirection) : null,
  })).digest('hex');
  const folder = result.site.slug + '-' + result.fingerprint.slice(0, 12);
  const root = resolve(baseDir, folder);
  const articlesDir = join(root, 'articles');
  await mkdir(articlesDir, { recursive: true });
  const magazineOutline = planMagazineOutline(result);
  const outputFiles = {
    'magazine-outline.json': magazineOutline,
    'site.json': result.site,
    'visual-plan.json': result.visualPlan,
    'media-plan.json': result.mediaPlan,
    'manifest.json': result.manifest,
    'pages.json': result.pages,
    'evidence.json': result.evidence,
    'sources.json': result.sourceSnapshots,
    'desks.json': [
      ...(result.articles.some((item) => item.desk === 'products')
        ? [{ id: 'products', name: 'Products', order: 1 }]
        : []),
      { id: 'suppliers', name: 'Suppliers', order: 2 },
      { id: 'guides', name: 'Buying guides', order: 3 },
    ],
    'authors.json': [
      {
        id: 'editorial',
        name: 'Buyer Notes editorial desk',
        role: 'Evidence-led buying review',
        bio: 'Prepared from enterprise records and captured website pages; no independent supplier audit is implied.',
      },
    ],
    ...(options.editorialDraft ? { 'editorial-draft.json': options.editorialDraft } : {}),
    ...(artDirection ? { 'art-direction.json': artDirection } : {}),
    'receipt.json': {
      version: '1.0.0',
      fingerprint: result.fingerprint,
      render_policy: renderPolicy,
      enterprise_id: input.enterprise.id,
      enterprise_revision: input.enterprise.revision,
      exported_at: input.exported_at,
      preview_only: true,
      publication_blockers: result.publication_blockers,
      source_count: result.sourceSnapshots.length,
      article_count: result.articles.length,
      editorial_draft_sha256: options.editorialDraft ? hash(options.editorialDraft) : null,
      art_direction_sha256: artDirection ? hash(artDirection) : null,
    },
  };
  for (const [name, value] of Object.entries(outputFiles)) {
    await writeFile(join(root, name), json(value), { flag: 'w', mode: 0o600 });
  }
  // Media is resolved from server-owned, tenant-scoped approved files.
  // No supplier image URLs are fetched or assumed to have publication rights.
  const mediaReport = await materializeEditionMedia({
    ...options,
    mediaPlan: result.mediaPlan,
    visualPlan: result.visualPlan,
    articles: result.articles,
    articlesDir,
    enterpriseId: input.enterprise.id,
  });
  await writeFile(join(root, 'media-report.json'), json(mediaReport), { mode: 0o600 });
  const magazineIssue = compileMagazineIssueFromEnterprise({
    compiled: result, outline: magazineOutline, mediaPlan: result.mediaPlan, mediaReport,
  });
  if (options.editorialDraft) {
    const questions = options.editorialDraft.buyerQuestions;
    const spread = magazineIssue.spreads.find((item) => item.id === 'buyer-questions');
    if (!spread) throw new Error('EDITORIAL_BUYER_QUESTIONS_SPREAD_MISSING');
    spread.questions = questions.map(({ title, body }) => ({ title, body }));
    spread.evidenceRefs = unique([...spread.evidenceRefs, ...questions.flatMap((item) => item.evidenceRefs)]);
  }
  assertMagazineIssue(magazineIssue);
  await assertIssueMediaFiles({ issue: magazineIssue, articlesDir });
  await writeFile(join(root, 'magazine-issue.json'), json(magazineIssue), { mode: 0o600, flag: 'w' });
  const dateString = new Date(input.exported_at).toISOString().slice(0, 10);
  for (const item of result.articles) {
    const media = mediaReport.images.find((image) => image.page_id === item.slug);
    if (!media) throw new Error('MEDIA_BINDING_MISSING: ' + item.slug);
    await writeFile(join(articlesDir, item.slug + '.md'), articleMarkdown(item, dateString, media), { mode: 0o600, flag: 'w' });
  }
  return {
    root,
    site_slug: result.site.slug,
    fingerprint: result.fingerprint,
    pages: result.pages.length,
    articles: result.articles.length,
    magazine_issue_id: magazineIssue.id,
    magazine_spreads: magazineIssue.spreads.length,
    editorialDraftSha256: options.editorialDraft ? hash(options.editorialDraft) : null,
    artDirectionSha256: artDirection ? hash(artDirection) : null,
    media: { rightsPhotos: mediaReport.rights_photo_count, aiGenerated: mediaReport.ai_generated_count, fallback: mediaReport.abstract_fallback_count },
    preview_only: true,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const inputFile = process.argv[2];
  if (!inputFile) {
    console.error('Usage: node site-builder/build.mjs path/to/enterprise-site-input.json');
    process.exitCode = 2;
  } else {
    try {
      const input = JSON.parse(await readFile(inputFile, 'utf8'));
      const result = await writeSitePreview(input);
      console.log(JSON.stringify(result, null, 2));
      console.log('For private Astro preview: BUYERSITE_BUILD_ROOT=' + result.root + ' pnpm build');
    } catch (error) {
      console.error(String(error.code || 'SITE_BUILD_FAILED') + ': ' + error.message);
      process.exitCode = 1;
    }
  }
}
