import { createHash } from 'node:crypto';
import { lstat, readFile, realpath, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { normalizeMediaAssets } from './media-policy.mjs';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const HEX = /^[a-f0-9]{64}$/;
const ID = /^[a-z0-9][a-z0-9_-]{0,79}$/;
const fail = (code) => { const error = Error(code); error.code = code; throw error; };

async function tenantRoot(mediaRoot, enterpriseId) {
  if (typeof mediaRoot !== 'string' || !isAbsolute(mediaRoot)) fail('APPROVED_MEDIA_ROOT_REQUIRED');
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:@+-]{0,199}$/.test(enterpriseId || '')) fail('APPROVED_MEDIA_TENANT_INVALID');
  const tenant = join(await realpath(mediaRoot), enterpriseId);
  const info = await lstat(tenant);
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(tenant) !== tenant) fail('APPROVED_MEDIA_TENANT_INVALID');
  return tenant;
}

async function privateFile(path, limit) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > limit || await realpath(path) !== path) {
    fail('APPROVED_MEDIA_REGISTRY_INVALID');
  }
  return readFile(path);
}

// Both the immutable source snapshot and the CURRENT private registry must agree.
// A frozen approval cannot override an expired, withdrawn or changed grant.
export async function assertCurrentLicensedSelection({ asset, enterpriseId, mediaRoot, asOf = new Date().toISOString() }) {
  if (!asset || !ID.test(asset.asset_id || '') || !ID.test(asset.page_id || '') ||
      !HEX.test(asset.source_sha256 || '') || !HEX.test(asset.grant_sha256 || '') || !HEX.test(asset.rights_sha256 || '')) {
    fail('APPROVED_MEDIA_RIGHTS_INVALID');
  }
  const normalized = normalizeMediaAssets([{
    asset_id: asset.asset_id, page_id: asset.page_id, sha256: asset.source_sha256,
    alt: asset.alt, credit: asset.credit, rights: asset.rights,
  }], asOf)[0];
  if (!normalized.approved || normalized.rights.enterprise_id !== enterpriseId ||
      normalized.grant_sha256 !== asset.grant_sha256 || normalized.expires_at !== (asset.expires_at || null) ||
      sha256(JSON.stringify(normalized.rights)) !== asset.rights_sha256) fail('APPROVED_MEDIA_RIGHTS_INVALID_OR_EXPIRED');
  const tenant = await tenantRoot(mediaRoot, enterpriseId);
  let revoked;
  try { revoked = await lstat(join(tenant, 'grants', asset.grant_sha256 + '.revoked.json')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  // Even a damaged revocation record is a stop signal, never an approval.
  if (revoked) fail('APPROVED_MEDIA_RIGHTS_REVOKED');
  let current;
  try { current = JSON.parse(await privateFile(join(tenant, 'rights', asset.asset_id + '.json'), 32_000)); }
  catch { fail('APPROVED_MEDIA_CURRENT_RIGHTS_MISSING'); }
  if (current.enterprise_id !== enterpriseId || current.descriptor?.asset_id !== asset.asset_id) fail('APPROVED_MEDIA_CURRENT_RIGHTS_MISMATCH');
  const live = normalizeMediaAssets([current.descriptor], asOf)[0];
  if (!live.approved || live.page_id !== asset.page_id || live.sha256 !== asset.source_sha256 ||
      live.alt !== asset.alt || live.credit !== asset.credit ||
      sha256(JSON.stringify(live.rights)) !== asset.rights_sha256) fail('APPROVED_MEDIA_CURRENT_RIGHTS_MISMATCH');
  let grant;
  try { grant = await privateFile(join(tenant, 'grants', asset.grant_sha256 + '.bin'), 2_000_000); }
  catch { fail('APPROVED_MEDIA_GRANT_MISMATCH'); }
  if (grant.length < 32 || sha256(grant) !== asset.grant_sha256) fail('APPROVED_MEDIA_GRANT_MISMATCH');
  let sourceBytes;
  try { sourceBytes = await privateFile(join(tenant, asset.source_sha256 + '.bin'), 12_000_000); }
  catch { fail('APPROVED_MEDIA_INVALID'); }
  if (sha256(sourceBytes) !== asset.source_sha256) fail('APPROVED_MEDIA_HASH_MISMATCH');
  return { tenant, sourceBytes, rights_sha256: asset.rights_sha256 };
}

// Authenticated operator/host operation. A revoked grant stays revoked; restoring
// rights requires a new evidenced grant, never deletion of this tombstone.
export async function revokePublicationGrant({ mediaRoot, enterpriseId, grantSha256, revokedBy, reason }) {
  if (!HEX.test(grantSha256 || '') || typeof revokedBy !== 'string' || !revokedBy.trim() || revokedBy.length > 120 ||
      typeof reason !== 'string' || !reason.trim() || reason.length > 500) fail('MEDIA_REVOCATION_INVALID');
  const tenant = await tenantRoot(mediaRoot, enterpriseId);
  const grant = await privateFile(join(tenant, 'grants', grantSha256 + '.bin'), 2_000_000);
  if (sha256(grant) !== grantSha256) fail('APPROVED_MEDIA_GRANT_MISMATCH');
  const receipt = { schema_version: '1.0.0', enterprise_id: enterpriseId, grant_sha256: grantSha256,
    status: 'revoked', revoked_at: new Date().toISOString(), revoked_by: revokedBy, reason };
  const path = join(tenant, 'grants', grantSha256 + '.revoked.json');
  try { await writeFile(path, JSON.stringify(receipt) + '\n', { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  return { status: 'revoked', grant_sha256: grantSha256 };
}
