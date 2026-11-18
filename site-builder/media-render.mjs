import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import sharp from 'sharp';
import { renderEditorialArtwork } from './visual-director.mjs';
import { assertPng, generateEditorialPng, makeEditorialPrompt, IMAGE_MODELS } from './image-generator.mjs';

export class MediaRenderError extends Error {
  constructor(code, message) { super(message); this.name = 'MediaRenderError'; this.code = code; }
}
const fail = (code, message) => { throw new MediaRenderError(code, message); };
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const HEX = /^[a-f0-9]{64}$/;
const PAGE_ID = /^[a-z0-9][a-z0-9-]{0,79}$/;

async function atomicFile(path, bytes) {
  const temporary = path + '.' + randomUUID() + '.tmp';
  try {
    await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}

async function normalizedGeneratedImage(bytes) {
  assertPng(bytes);
  const meta = await sharp(bytes, { limitInputPixels: 40_000_000 }).metadata().catch(() => null);
  if (!meta || meta.format !== 'png' || (meta.pages || 1) !== 1 ||
      meta.width < 640 || meta.height < 400 || meta.width > 8000 || meta.height > 8000) {
    fail('MEDIA_GENERATION_INVALID_IMAGE', 'Generated artwork must be a bounded, usable still PNG');
  }
  return sharp(bytes, { limitInputPixels: 40_000_000 })
    .resize(1600, 1067, { fit: 'cover' }).png().toBuffer();
}

async function cachedGeneration({ cacheDir, enterpriseId, article, prompt, model, apiKey, imageGenerator }) {
  const binding = {
    version: '1.0.0', enterprise_id: enterpriseId, page_id: article.slug,
    prompt_sha256: sha256(prompt), model, size: '1536x1024', quality: 'medium',
    output_format: 'png', normalized_size: '1600x1067',
  };
  const key = sha256(JSON.stringify(binding));
  await mkdir(cacheDir, { recursive: true, mode: 0o700 });
  const root = resolve(cacheDir);
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || await realpath(root) !== root) {
    fail('MEDIA_CACHE_INVALID', 'Generated image cache must be a private regular directory');
  }
  const receiptFile = join(root, key + '.json');
  const imageFile = join(root, key + '.png');
  let info;
  try { info = await lstat(receiptFile); } catch (cause) { if (cause.code !== 'ENOENT') throw cause; }
  if (info) {
    if (!info.isFile() || info.isSymbolicLink() || info.size > 4096) fail('MEDIA_CACHE_INVALID', 'Invalid generated image receipt');
    let receipt;
    try { receipt = JSON.parse(await readFile(receiptFile, 'utf8')); }
    catch { fail('MEDIA_CACHE_INVALID', 'Unreadable generated image receipt'); }
    if (receipt.key !== key || JSON.stringify(receipt.binding) !== JSON.stringify(binding) || !HEX.test(receipt.sha256 || '')) {
      fail('MEDIA_CACHE_INVALID', 'Generated image cache binding changed');
    }
    let bytes;
    try {
      const imageInfo = await lstat(imageFile);
      if (!imageInfo.isFile() || imageInfo.isSymbolicLink() || imageInfo.size > 12_000_000) throw Error('invalid file');
      bytes = assertPng(await readFile(imageFile));
      if (sha256(bytes) !== receipt.sha256) throw Error('hash mismatch');
      const metadata = await sharp(bytes, { limitInputPixels: 40_000_000 }).metadata();
      if (metadata.width !== 1600 || metadata.height !== 1067 || (metadata.pages || 1) !== 1) throw Error('invalid dimensions');
    } catch { fail('MEDIA_CACHE_INVALID', 'Cached image bytes changed or are unreadable'); }
    return { bytes, promptSha: binding.prompt_sha256, model, cacheHit: true };
  }
  const result = await imageGenerator({ apiKey, prompt, model });
  if (result?.model !== model || result?.prompt_sha256 !== binding.prompt_sha256 ||
      (result.sha256 && result.sha256 !== sha256(assertPng(result.bytes)))) {
    fail('MEDIA_GENERATION_RECEIPT_INVALID', 'Image provider receipt does not match its request or bytes');
  }
  const bytes = await normalizedGeneratedImage(result.bytes);
  // The receipt is committed last; an interrupted write cannot bless partial PNGs.
  await atomicFile(imageFile, bytes);
  await atomicFile(receiptFile, JSON.stringify({ key, binding, sha256: sha256(bytes) }) + '\n');
  return { bytes, promptSha: binding.prompt_sha256, model, cacheHit: false };
}

async function licensedBytes({ asset, enterpriseId, mediaRoot }) {
  if (asset.expires_at && (!/^\d{4}-\d{2}-\d{2}T/.test(asset.expires_at) ||
      !Number.isFinite(Date.parse(asset.expires_at)) || Date.parse(asset.expires_at) <= Date.now())) {
    fail('APPROVED_MEDIA_RIGHTS_EXPIRED', 'Publication rights expired or have an invalid expiry');
  }
  if (typeof mediaRoot !== 'string' || !isAbsolute(mediaRoot)) fail('APPROVED_MEDIA_ROOT_REQUIRED', 'Configured private absolute media root required for licensed photography');
  if (typeof enterpriseId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:@+-]{0,199}$/.test(enterpriseId)) fail('APPROVED_MEDIA_TENANT_INVALID', 'Unsafe tenant identifier');
  const root = await realpath(mediaRoot);
  const tenant = join(root, enterpriseId);
  const tenantInfo = await lstat(tenant);
  if (!tenantInfo.isDirectory() || tenantInfo.isSymbolicLink() || (await realpath(tenant)) !== tenant) {
    fail('APPROVED_MEDIA_TENANT_INVALID', 'Tenant media storage must not be linked');
  }
  const grantFile = join(tenant, 'grants', asset.grant_sha256 + '.bin');
  try {
    const grantInfo = await lstat(grantFile);
    if (!grantInfo.isFile() || grantInfo.isSymbolicLink() || grantInfo.size < 32 || grantInfo.size > 2_000_000 ||
        await realpath(grantFile) !== grantFile || sha256(await readFile(grantFile)) !== asset.grant_sha256) {
      throw Error('invalid grant');
    }
  } catch {
    fail('APPROVED_MEDIA_GRANT_MISMATCH', 'Retained tenant grant bytes are missing or changed');
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
  mediaCacheDir,
} = {}) {
  if (!Array.isArray(mediaPlan?.selections) || !Array.isArray(visualPlan?.images) || !Array.isArray(articles) ||
      articles.length < 1 || articles.length > 14 ||
      mediaPlan.selections.length !== articles.length || visualPlan.images.length !== articles.length ||
      !HEX.test(mediaPlan.plan_sha256 || '') || sha256(JSON.stringify(mediaPlan.selections)) !== mediaPlan.plan_sha256 ||
      new Set(articles.map((a) => a?.slug)).size !== articles.length ||
      new Set(mediaPlan.selections.map((s) => s?.page_id)).size !== articles.length ||
      new Set(visualPlan.images.map((s) => s?.page_id)).size !== articles.length ||
      articles.some((a) => !PAGE_ID.test(a?.slug || '')) ||
      typeof articlesDir !== 'string' || !isAbsolute(articlesDir) ||
      !Number.isInteger(maxAiImages) || maxAiImages < 0 || maxAiImages > 6 ||
      !IMAGE_MODELS.includes(imageModel)) {
    fail('MEDIA_PLAN_INVALID', 'A bounded immutable visual plan is required');
  }
  const summary = [];
  let generatedCount = 0;
  let cacheHits = 0;
  const visualPages = new Map();
  for (const article of articles) {
    const planned = mediaPlan.selections.find((s) => s.page_id === article.slug);
    const drawing = visualPlan.images.find((s) => s.page_id === article.slug);
    if (!planned || !drawing || drawing.asset !== 'hero-' + article.slug + '.png') {
      fail('MEDIA_PLAN_INVALID', 'Page is not bound to its own approved hero');
    }
    let kind, bytes, promptSha = null, model = null;
    if (planned.media_kind === 'licensed-photo') {
      if (!HEX.test(planned.source_sha256 || '') || !HEX.test(planned.grant_sha256 || '') ||
          typeof planned.alt !== 'string' || !planned.alt.trim() || typeof planned.credit !== 'string' || !planned.credit.trim()) {
        fail('MEDIA_PLAN_INVALID', 'Licensed media requires its exact source, grant, alt text and credit');
      }
      bytes = await licensedBytes({ asset: planned, enterpriseId, mediaRoot });
      kind = 'licensed-photo';
    } else if (planned.media_kind === 'generation-requested') {
      if (aiGenerationAuthorized === true && apiKey && generatedCount < maxAiImages) {
        const prompt = makeEditorialPrompt({ title: article.title, pageType: article.pageType, direction: visualPlan.art_direction });
        const result = await cachedGeneration({
          cacheDir: mediaCacheDir || join(dirname(articlesDir), '.media-cache'),
          enterpriseId, article, prompt, model: imageModel, apiKey, imageGenerator,
        });
        bytes = result.bytes;
        promptSha = result.promptSha;
        model = result.model;
        if (result.cacheHit) cacheHits++;
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
    const normalized = bytes;
    const outputHash = sha256(normalized);
    const reusedFrom = visualPages.get(outputHash) || null;
    if (!reusedFrom) visualPages.set(outputHash, article.slug);
    await atomicFile(output, normalized);
    summary.push({
      page_id: article.slug,
      filename: drawing.asset,
      kind,
      sha256: outputHash,
      source_sha256: kind === 'licensed-photo' ? planned.source_sha256 : null,
      grant_sha256: kind === 'licensed-photo' ? planned.grant_sha256 : null,
      asset_id: kind === 'licensed-photo' ? planned.asset_id : null,
      rights_expires_at: kind === 'licensed-photo' ? planned.expires_at : null,
      reused_from_page_id: reusedFrom,
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
    ai_cache_hit_count: cacheHits,
    ai_provider_call_count: generatedCount - cacheHits,
    rights_photo_count: summary.filter((s) => s.kind === 'licensed-photo').length,
    abstract_fallback_count: summary.filter((s) => s.kind === 'abstract-fallback').length,
    quality_warnings: summary.filter((s) => s.reused_from_page_id).map((s) => ({
      code: 'REUSED_IMAGE', page_id: s.page_id, original_page_id: s.reused_from_page_id,
    })),
    review_required: true,
    publication: 'BLOCKED',
  };
}
