import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { importApprovedPhoto } from './media-import.mjs';

test('importer rejects expired grants, missing attestations and pre-existing hash-path symlinks', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'media-import-'));
  try {
    const imagePath = join(dir, 'synthetic-art.png');
    const rightsDocumentPath = join(dir, 'synthetic-grant.txt');
    const bytes = await sharp({ create: { width: 800, height: 600, channels: 3, background: '#889aaa' } }).png().toBuffer();
    await writeFile(imagePath, bytes);
    await writeFile(rightsDocumentPath, 'SYNTHETIC GRANT for authored test pixels only; not a supplier publication authorization.');
    const options = {
      mediaRoot: join(dir, 'private'), enterpriseId: 'test-company', pageId: 'sample', assetId: 'test-asset',
      imagePath, rightsDocumentPath, alt: 'Synthetic test image', credit: 'Synthetic test fixture',
      grantedBy: 'test-operator', attestRights: true,
    };
    await assert.rejects(() => importApprovedPhoto({ ...options, expiresAt: '2000-01-01T00:00:00Z' }), /MEDIA_RIGHTS_INVALID_OR_EXPIRED/);
    await assert.rejects(() => importApprovedPhoto({ ...options, expiresAt: 'invalid' }), /MEDIA_RIGHTS_INVALID_OR_EXPIRED/);
    await assert.rejects(() => importApprovedPhoto({ ...options, attestRights: 'true' }), /MEDIA_RIGHTS_ATTESTATION_REQUIRED/);
    const tenant = join(options.mediaRoot, options.enterpriseId);
    await mkdir(tenant, { recursive: true });
    const stored = join(tenant, createHash('sha256').update(bytes).digest('hex') + '.bin');
    await symlink(imagePath, stored);
    await assert.rejects(() => importApprovedPhoto(options), /MEDIA_STORAGE_SYMLINK_FORBIDDEN/);
    await rm(stored);
    await writeFile(stored, 'Corrupt prior registry bytes');
    await assert.rejects(() => importApprovedPhoto(options), /MEDIA_STORAGE_CONFLICT/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
