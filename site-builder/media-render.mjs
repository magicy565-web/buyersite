import { createHash } from 'node:crypto';
import { lstat, readFile, realpath, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve, sep } from 'node:path';
import sharp from 'sharp';
import { renderEditorialArtwork } from './visual-director.mjs';
import { assertPng, generateEditorialPng, makeEditorialPrompt } from './image-generator.mjs';

export class MediaRenderError extends Error {
  constructor(code, message) { super(message); this.name = 'MediaRenderError'; this.code = code; }
}
const fail = (code, message) => { throw new MediaRenderError(code, message); };
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function licensedBytes({ asset, enterpriseId, mediaRoot }) {
  if (typeof mediaRoot !== 'string' || !isAbsolute(mediaRoot)) fail('APPROVED_MEDIA_ROOT_REQUIRED', 'Configured private absolute media root required for licensed photography');
  if (typeof enterpriseId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:@+-]{0,199}$/.test(enterpriseId)) fail('APPROVED_MEDIA_TENANT_INVALID', 'Unsafe tenant identifier');
  const root = await realpath(mediaRoot);
  const tenant = join(root, enterpriseId);
  const tenantInfo = await lstat(tenant);
  if (!tenantInfo.isDirectory() || tenantInfo.isSymbolicLink() || (await realpath(tenant)) !== tenant) {
    fail('APPROVED_MEDIA_TENANT_INVALID', 'Tenant media storage must not be linked');
  }
  const file = resolve(tenant, asset.source_sha256 + '.bin');
  if (!file.startsWith(tenant + sep)) fail('APPROVED_MEDIA_PATH_INVALID', 'Cross-tenant path blocked');
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 12_000_000) fail('APPROVED_MEDIA_INVALID', 'Private asset must be a bounded regular file');
  const bytes = await readFile(file);
  if (sha256(bytes) !== asset.source_sha256) fail('APPROVED_MEDIA_HASH_MISMATCH', 'Media bytes do not match frozen asset hash');
  const meta = await sharp(bytes, { limitInputPixels: 40_000_000 }).metadata().catch(() => null);
  if (!meta || !['png', 'jpeg', 'webp'].includes(meta.format) ||
      (meta.pages || 1) !== 1 || meta.width < 640 || meta.height < 400 ||
      meta.width > 8000 || meta.height > 8000) fail('APPROVED_MEDIA_INVALID', 'Asset is not a supported, sufficiently large still photo');
  return sharp(bytes, { limitInputPixels: 40_000_000 })
    .resize(1600, 1067, { fit: 'cover', position: 'attention', withoutEnlargement: false })
    .png({ compressionLevel: 9 })
    .toBuffer();
}

export async function materializeEditionMedia({
  mediaPlan, visualPlan, articles, articlesDir, enterpriseId,
  mediaRoot = process.env.BUYERSITE_MEDIA_ROOT || null,
  aiGenerationAuthorized = false,
  apiKey = process.env.OPENAI_API_KEY || null,
  imageModel = process.env.BUYERSITE_IMAGE_MODEL || 'gpt-image-2',
  maxAiImages = 4,
  imageGenerator = generateEditorialPng,
} = {}) {
  if (!mediaPlan?.selections || !Array.isArray(visualPlan?.images) || !Array.isArray(articles) ||
      !Number.isInteger(maxAiImages) || maxAiImages < 0 || maxAiImages > 6) {
    fail('MEDIA_PLAN_INVALID', 'A bounded immutable visual plan is required');
  }
  const summary = [];
  let generatedCount = 0;
  for (const article of articles) {
    const planned = mediaPlan.selections.find((s) => s.page_id === article.slug);
    const drawing = visualPlan.images.find((s) => s.page_id === article.slug);
    if (!planned || !drawing || drawing.asset !== 'hero-' + article.slug + '.png') {
      fail('MEDIA_PLAN_INVALID', 'Page is not bound to its own approved hero');
    }
    let kind, bytes, promptSha = null, model = null;
    if (planned.media_kind === 'licensed-photo') {
      bytes = await licensedBytes({ asset: planned, enterpriseId, mediaRoot });
      kind = 'licensed-photo';
    } else if (planned.media_kind === 'generation-requested') {
      if (aiGenerationAuthorized && apiKey && generatedCount < maxAiImages) {
        const prompt = makeEditorialPrompt({ title: article.title, pageType: article.pageType, direction: visualPlan.art_direction });
        const result = await imageGenerator({ apiKey, prompt, model: imageModel });
        bytes = assertPng(result?.bytes);
        promptSha = result.prompt_sha256 || sha256(Buffer.from(prompt));
        model = result.model || imageModel;
        kind = 'ai-generated';
        generatedCount++;
      } else {
        const svg = renderEditorialArtwork({
          direction: visualPlan.direction, pageId: drawing.page_id,
          sequence: drawing.sequence, composition: drawing.composition,
        });
        bytes = await sharp(Buffer.from(svg)).png().toBuffer();
        kind = 'abstract-fallback';
      }
    } else {
      fail('MEDIA_PLAN_INVALID', 'Unrecognized media decision');
    }
    const output = join(articlesDir, drawing.asset);
    // Model output is still decoded and normalized through Sharp before using
    // Astro. No external URLs, HTML or SVG from a model enter the rendered site.
    const normalized = kind === 'ai-generated'
      ? await sharp(bytes, { limitInputPixels: 40_000_000 }).resize(1600, 1067, { fit: 'cover' }).png().toBuffer()
      : bytes;
    await writeFile(output, normalized, { mode: 0o600 });
    summary.push({
      page_id: article.slug,
      filename: drawing.asset,
      kind,
      sha256: sha256(normalized),
      source_sha256: kind === 'licensed-photo' ? planned.source_sha256 : null,
      grant_sha256: kind === 'licensed-photo' ? planned.grant_sha256 : null,
      generation_model: model,
      prompt_sha256: promptSha,
      alt: kind === 'licensed-photo' ? planned.alt : 'Conceptual editorial illustration for ' + article.title,
      credit: kind === 'licensed-photo' ? planned.credit :
        kind === 'ai-generated' ? 'AI-generated editorial concept illustration; not product photography' :
          'Original abstract editorial artwork; not product photography',
      caption: kind === 'licensed-photo' ? 'Approved supplier-supplied editorial photo. Product facts still require citations.' :
        'Conceptual artwork only. Not a depiction of any supplier product, factory or certification.',
    });
  }
  return {
    schema_version: '1.0.0',
    plan_sha256: mediaPlan.plan_sha256,
    images: summary,
    ai_generated_count: generatedCount,
    rights_photo_count: summary.filter((s) => s.kind === 'licensed-photo').length,
    abstract_fallback_count: summary.filter((s) => s.kind === 'abstract-fallback').length,
    review_required: true,
    publication: 'BLOCKED',
  };
}
