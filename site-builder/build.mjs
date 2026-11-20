import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileEnterpriseSite } from './compile.mjs';
import { materializeEditionMedia } from './media-render.mjs';
import { createHash } from 'node:crypto';
import { planEditionLayout, layoutInputsFromPack } from './layout-planner.mjs';

const json = (value) => JSON.stringify(value, null, 2) + '\n';
const inline = (value) => JSON.stringify(value);
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
  const result = compileEnterpriseSite(input);
  const renderPolicy = {
    aiGenerationAuthorized: options.aiGenerationAuthorized === true,
    imageModel: options.imageModel || process.env.BUYERSITE_IMAGE_MODEL || 'gpt-image-2',
    maxAiImages: options.maxAiImages ?? 4,
    imageProviderConfigured: Boolean(Object.hasOwn(options,'apiKey') ? options.apiKey : process.env.OPENAI_API_KEY),
  };
  result.fingerprint = createHash('sha256').update(JSON.stringify({ content: result.fingerprint, renderPolicy })).digest('hex');
  const folder = result.site.slug + '-' + result.fingerprint.slice(0, 12);
  const root = resolve(baseDir, folder);
  const articlesDir = join(root, 'articles');
  await mkdir(articlesDir, { recursive: true });
  const outputFiles = {
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
    },
  };
  for (const [name, value] of Object.entries(outputFiles)) {
    await writeFile(join(root, name), json(value), { flag: 'w' });
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
  // The layout plan depends on what media actually materialized, so it is planned here, from the
  // pack's own records. validate-content re-plans from the same files and rejects any drift.
  const layoutPlan = planEditionLayout(layoutInputsFromPack({
    pages: result.pages, evidence: result.evidence, mediaReport, site: result.site, visualPlan: result.visualPlan,
  }));
  await writeFile(join(root, 'layout-plan.json'), json(layoutPlan));
  const dateString = new Date(input.exported_at).toISOString().slice(0, 10);
  for (const item of result.articles) {
    const media = mediaReport.images.find((image) => image.page_id === item.slug);
    if (!media) throw new Error('MEDIA_BINDING_MISSING: ' + item.slug);
    await writeFile(join(articlesDir, item.slug + '.md'), articleMarkdown(item, dateString, media));
  }
  return {
    root,
    site_slug: result.site.slug,
    fingerprint: result.fingerprint,
    pages: result.pages.length,
    articles: result.articles.length,
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
