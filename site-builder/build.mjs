import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { compileEnterpriseSite } from './compile.mjs';
import { renderEditorialArtwork } from './visual-director.mjs';

const json = (value) => JSON.stringify(value, null, 2) + '\n';
const inline = (value) => JSON.stringify(value);
const markdown = (value) =>
  String(value)
    .replace(/\\/g, '\\\\')
    .replace(/[<>&]/g, (char) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[char])
    .replace(/([\x60*_{}\[\]()#+.!|])/g, '\\$1');
const heading = (value) => markdown(value).replace(/^\\/, '');

export function articleMarkdown(entry, dateString) {
  const props = [
    ['title', entry.title],
    ['deck', entry.deck],
    ['desk', entry.desk],
    ['byline', ['editorial']],
    ['date', dateString],
    ['hero', './hero-' + entry.slug + '.png'],
    ['heroAlt', 'Abstract editorial illustration for ' + entry.title + '; not supplier product photography'],
    ['heroCaption', 'Illustration only; product and supplier claims require their own evidence.'],
    ['heroCredit', 'Original abstract editorial artwork · not supplier photography'],
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

export async function writeSitePreview(input, baseDir = '.generated/company-sites') {
  const result = compileEnterpriseSite(input);
  const folder = result.site.slug + '-' + result.fingerprint.slice(0, 12);
  const root = resolve(baseDir, folder);
  const articlesDir = join(root, 'articles');
  await mkdir(articlesDir, { recursive: true });
  const outputFiles = {
    'site.json': result.site,
    'visual-plan.json': result.visualPlan,
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
  // Render one original abstract illustration per article. Do not pass untrusted
  // supplier SVG/media to sharp or imply that abstract art depicts real products.
  const dateString = new Date(input.exported_at).toISOString().slice(0, 10);
  for (const item of result.articles) {
    const artwork = result.visualPlan.images.find((image) => image.page_id === item.slug);
    if (!artwork) throw new Error('MISSING_VISUAL_PLAN: ' + item.slug);
    const svg = renderEditorialArtwork({
      direction: result.visualPlan.direction,
      pageId: artwork.page_id,
      sequence: artwork.sequence,
      composition: artwork.composition,
    });
    await sharp(Buffer.from(svg)).png().toFile(join(articlesDir, artwork.asset));
    await writeFile(join(articlesDir, item.slug + '.md'), articleMarkdown(item, dateString));
  }
  return {
    root,
    site_slug: result.site.slug,
    fingerprint: result.fingerprint,
    pages: result.pages.length,
    articles: result.articles.length,
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
