import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, writeFile, lstat, realpath } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { normalizeMediaAssets } from './media-policy.mjs';

async function boundedRegularFile(path, maximum, minimum = 1) {
  if (typeof path !== 'string' || !path) throw Error('MEDIA_IMAGE_AND_GRANT_REQUIRED');
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size < minimum || info.size > maximum) throw Error('MEDIA_INPUT_SIZE_INVALID');
    const chunks = [];
    let total = 0;
    while (true) {
      const chunk = Buffer.alloc(Math.min(65_536, maximum + 1 - total));
      const { bytesRead } = await handle.read(chunk);
      if (!bytesRead) break;
      total += bytesRead;
      if (total > maximum) throw Error('MEDIA_INPUT_SIZE_INVALID');
      chunks.push(chunk.subarray(0, bytesRead));
    }
    if (total < minimum) throw Error('MEDIA_INPUT_SIZE_INVALID');
    return Buffer.concat(chunks, total);
  } finally { await handle.close(); }
}

async function privateDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(path) !== path) {
    throw Error('MEDIA_STORAGE_SYMLINK_FORBIDDEN');
  }
}

async function storeVerifiedFile(path, bytes, hash, limit) {
  try { await writeFile(path, bytes, { flag: 'wx', mode: 0o600 }); }
  catch (cause) {
    if (cause?.code !== 'EEXIST') throw cause;
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw Error('MEDIA_STORAGE_SYMLINK_FORBIDDEN');
    const existing = await boundedRegularFile(path, limit);
    if (createHash('sha256').update(existing).digest('hex') !== hash) throw Error('MEDIA_STORAGE_CONFLICT');
  }
}

// Trusted, operator-only importer. A rights grant document is required and
// its SHA is retained, but a human must still verify that the grant genuinely
// covers publication, cropping and resizing. No external image URLs are fetched.
export async function importApprovedPhoto({
  mediaRoot, enterpriseId, pageId, assetId, imagePath, rightsDocumentPath,
  alt, credit, grantedBy, expiresAt = null, attestRights = false,
}) {
  if (attestRights !== true) throw Error('MEDIA_RIGHTS_ATTESTATION_REQUIRED: authorized operator must review the grant');
  if (typeof mediaRoot !== 'string' || !isAbsolute(mediaRoot)) throw Error('MEDIA_ROOT_ABSOLUTE_REQUIRED');
  if (typeof enterpriseId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:@+-]{0,199}$/.test(enterpriseId)) {
    throw Error('MEDIA_TENANT_INVALID');
  }
  if (!imagePath || !rightsDocumentPath) throw Error('MEDIA_IMAGE_AND_GRANT_REQUIRED');
  const [image, evidence] = await Promise.all([
    boundedRegularFile(imagePath, 12_000_000, 100),
    boundedRegularFile(rightsDocumentPath, 2_000_000, 32),
  ]);
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
  if (!normalizeMediaAssets([descriptor], now)[0].approved) {
    throw Error('MEDIA_RIGHTS_INVALID_OR_EXPIRED');
  }
  await mkdir(mediaRoot, { recursive: true, mode: 0o700 });
  const root = join(await realpath(mediaRoot), enterpriseId);
  await privateDirectory(root);
  const grants = join(root, 'grants');
  await privateDirectory(grants);
  const path = join(root, descriptor.sha256 + '.bin');
  await storeVerifiedFile(join(grants, descriptor.rights.grant_sha256 + '.bin'), evidence, descriptor.rights.grant_sha256, 2_000_000);
  await storeVerifiedFile(path, image, descriptor.sha256, 12_000_000);
  return { descriptor, storage: 'private-sha256-registry', publication: 'BLOCKED_PENDING_FINAL_REVIEW' };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [mediaRoot, enterpriseId, pageId, assetId, imagePath, rightsDocumentPath, alt, credit, grantedBy, attestation, expiresFlag, expiresValue, ...extra] = process.argv.slice(2);
  if (attestation !== '--attest-rights-and-transforms' || extra.length ||
      (expiresFlag !== undefined && (expiresFlag !== '--expires-at' || !expiresValue))) {
    console.error('Usage: node site-builder/media-import.mjs <absolute-media-root> <enterprise-id> <page-id> <asset-id> <image> <grant-document> <alt> <credit> <granted-by> --attest-rights-and-transforms [--expires-at <ISO-timestamp>]');
    process.exitCode = 2;
  } else {
    try {
      const result = await importApprovedPhoto({ mediaRoot, enterpriseId, pageId, assetId, imagePath, rightsDocumentPath, alt, credit, grantedBy, attestRights: true, expiresAt: expiresValue || null });
      console.log(JSON.stringify(result, null, 2));
    } catch (e) { console.error(e.code || e.message); process.exitCode = 1; }
  }
}
