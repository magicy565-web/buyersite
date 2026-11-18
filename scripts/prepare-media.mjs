import { lstat, readFile, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { assertReviewedMedia, mediaHash } from '../site-builder/media-review.mjs';
import { assertCurrentLicensedSelection } from '../site-builder/media-rights.mjs';
import { normalizeLicensedPhoto } from '../site-builder/media-render.mjs';

const fail = (code) => { const error = Error(code); error.code = code; throw error; };
const field = (raw, name) => {
  const frontmatter = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const matches = frontmatter?.[1].split(/\r?\n/).filter((line) => line.startsWith(name + ':')) || [];
  if (matches.length !== 1) fail('MEDIA_ARTICLE_FIELD_INVALID');
  try { const value = JSON.parse(matches[0].slice(name.length + 1).trim()); if (typeof value === 'string' && value.trim()) return value; }
  catch { /* Media fields deliberately use unambiguous JSON-quoted YAML strings. */ }
  fail('MEDIA_ARTICLE_FIELD_INVALID');
};

export async function verifyPublicationMedia({ projectRoot = process.cwd(),
  mediaRoot = process.env.BUYERSITE_MEDIA_ROOT || null, asOf = new Date().toISOString() } = {}) {
  const root = await realpath(projectRoot);
  const registry = JSON.parse(await readFile(join(root, 'src/data/concept-media.json'), 'utf8'));
  const pilot = JSON.parse(await readFile(join(root, 'src/data/pilot.json'), 'utf8'));
  if (!Array.isArray(pilot.articles) || !pilot.articles.length || !Array.isArray(registry.assets) ||
      registry.assets.length !== pilot.articles.length || new Set(registry.assets.map((a) => a?.page_id)).size !== registry.assets.length) fail('MEDIA_COVERAGE_INVALID');
  const bindings = [];
  for (const article of pilot.articles) {
    if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(article.slug || '') || !/^[a-z0-9-]+$/.test(article.desk || '')) fail('MEDIA_PAGE_INVALID');
    const original = registry.assets.find((item) => item.page_id === article.slug);
    if (!original || !/^src\/assets\/(?:concepts|licensed)\/[a-z0-9-]+\.(?:png|jpe?g|webp)$/.test(original.file || '')) fail('MEDIA_ASSET_PATH_INVALID');
    const path = join(root, original.file);
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 12_000_000 || await realpath(path) !== path) fail('MEDIA_ASSET_FILE_INVALID');
    const bytes = await readFile(path);
    const metadata = await sharp(bytes, { limitInputPixels: 40_000_000 }).metadata();
    if (!['png', 'jpeg', 'webp'].includes(metadata.format) || (metadata.pages || 1) !== 1 || metadata.width < 1000 || metadata.height < 600) fail('MEDIA_ASSET_RESOLUTION_INVALID');
    const articlePath = join(root, 'src/content/articles', article.slug + '.md');
    const raw = await readFile(articlePath, 'utf8');
    if (resolve(dirname(articlePath), field(raw, 'hero')) !== path || field(raw, 'desk') !== article.desk ||
        field(raw, 'heroCredit') !== original.credit || field(raw, 'heroCaption') !== original.caption) fail('MEDIA_ARTICLE_BINDING_CHANGED');
    const asset = { ...original, alt: field(raw, 'heroAlt'),
      generation_model: original.generation_model || (original.kind === 'ai-generated' ? registry.model : null),
      generation_provider: original.generation_provider || (original.kind === 'ai-generated' ? registry.generation_provider : null) };
    const page = { page_id: article.slug, path: '/' + article.desk + '/' + article.slug + '/', title: field(raw, 'title') };
    if (asset.kind === 'licensed-photo') {
      const { sourceBytes } = await assertCurrentLicensedSelection({ asset: { ...asset, expires_at: asset.rights_expires_at || null },
        enterpriseId: asset.rights?.enterprise_id, mediaRoot, asOf });
      if (asset.sha256 !== asset.source_sha256 && asset.sha256 !== mediaHash(await normalizeLicensedPhoto(sourceBytes))) fail('MEDIA_LICENSED_DERIVATION_MISMATCH');
    }
    bindings.push(assertReviewedMedia({ page, asset, bytes, asOf }));
  }
  return { complete: true, assets: bindings.length, bindings };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.env.BUYERSITE_BUILD_ROOT) console.log('Enterprise media is resolved by the tenant-bound media pipeline.');
  else {
    const result = await verifyPublicationMedia();
    console.log('Verified ' + result.assets + ' media assets: exact bytes, provenance, page disclosures and observed AI reviews.');
  }
}
