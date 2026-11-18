import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, lstat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { normalizeMediaAssets } from './media-policy.mjs';

// Trusted, operator-only importer. A rights grant document is required and
// its SHA is retained, but a human must still verify that the grant genuinely
// covers publication, cropping and resizing. No external image URLs are fetched.
export async function importApprovedPhoto({
  mediaRoot, enterpriseId, pageId, assetId, imagePath, rightsDocumentPath,
  alt, credit, grantedBy, expiresAt = null, attestRights = false,
}) {
  if (!attestRights) throw Error('MEDIA_RIGHTS_ATTESTATION_REQUIRED: authorized operator must review the grant');
  if (typeof mediaRoot !== 'string' || !isAbsolute(mediaRoot)) throw Error('MEDIA_ROOT_ABSOLUTE_REQUIRED');
  if (typeof enterpriseId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:@+-]{0,199}$/.test(enterpriseId)) {
    throw Error('MEDIA_TENANT_INVALID');
  }
  if (!imagePath || !rightsDocumentPath) throw Error('MEDIA_IMAGE_AND_GRANT_REQUIRED');
  const [image, evidence] = await Promise.all([readFile(imagePath), readFile(rightsDocumentPath)]);
  if (image.length > 12_000_000 || image.length < 100 || evidence.length < 32 || evidence.length > 2_000_000) {
    throw Error('MEDIA_INPUT_SIZE_INVALID');
  }
  const meta = await sharp(image, { limitInputPixels: 40_000_000 }).metadata();
  if (!['png', 'jpeg', 'webp'].includes(meta.format) || (meta.pages || 1) !== 1 ||
      meta.width < 640 || meta.height < 400 || meta.width > 8000 || meta.height > 8000) {
    throw Error('MEDIA_IMAGE_UNSUPPORTED');
  }
  const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
  const now = new Date().toISOString();
  const descriptor = {
    asset_id: assetId, page_id: pageId, sha256: sha256(image), alt, credit,
    rights: {
      status: 'approved-public', scope: 'buyer-magazine-site',
      grant_sha256: sha256(evidence), granted_by: grantedBy,
      approved_at: now, expires_at: expiresAt,
      allow_resize: true, allow_crop: true,
    },
  };
  normalizeMediaAssets([descriptor], now);
  const root = join(mediaRoot, enterpriseId);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink()) throw Error('MEDIA_STORAGE_SYMLINK_FORBIDDEN');
  const path = join(root, descriptor.sha256 + '.bin');
  try { await writeFile(path, image, { flag: 'wx', mode: 0o600 }); }
  catch (cause) {
    if (cause?.code !== 'EEXIST') throw cause;
    if (sha256(await readFile(path)) !== descriptor.sha256) throw Error('MEDIA_STORAGE_CONFLICT');
  }
  return { descriptor, storage: 'private-sha256-registry', publication: 'BLOCKED_PENDING_FINAL_REVIEW' };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [mediaRoot, enterpriseId, pageId, assetId, imagePath, rightsDocumentPath, alt, credit, grantedBy, attestation] = process.argv.slice(2);
  if (attestation !== '--attest-rights-and-transforms') {
    console.error('Usage: node site-builder/media-import.mjs <absolute-media-root> <enterprise-id> <page-id> <asset-id> <image> <grant-document> <alt> <credit> <granted-by> --attest-rights-and-transforms');
    process.exitCode = 2;
  } else {
    try {
      const result = await importApprovedPhoto({ mediaRoot, enterpriseId, pageId, assetId, imagePath, rightsDocumentPath, alt, credit, grantedBy, attestRights: true });
      console.log(JSON.stringify(result, null, 2));
    } catch (e) { console.error(e.code || e.message); process.exitCode = 1; }
  }
}
