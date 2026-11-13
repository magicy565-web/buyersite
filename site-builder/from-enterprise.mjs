import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { captureCompanyHomepage } from './capture.mjs';
import { writeSitePreview } from './build.mjs';
import { SiteInputError } from './compile.mjs';

/** Server-only adapter for the existing StudioStore job + source.json bytes.
 * This binding check does not replace native authentication. Never expose it as
 * a visitor upload API or accept a browser-supplied job/enterprise identity.
 */
export async function createSiteFromStudio(job, sourceBytes, options = {}) {
  const fail = (code, message) => {
    throw new SiteInputError(code, message);
  };
  if (
    !job ||
    typeof job.enterpriseId !== 'string' ||
    !job.enterpriseId ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(job.id || '') ||
    !/^[a-f0-9]{64}$/.test(job.sourceHash || '')
  ) {
    fail(
      'STUDIO_SOURCE_BINDING_REQUIRED',
      'A server-owned Studio job and frozen source hash are required',
    );
  }
  if (!Buffer.isBuffer(sourceBytes) || sourceBytes.length > 2_000_000) {
    fail('STUDIO_SOURCE_REQUIRED', 'Pass the original bounded source.json bytes');
  }
  const digest = createHash('sha256').update(sourceBytes).digest('hex');
  if (digest !== job.sourceHash)
    fail('STUDIO_SOURCE_CHANGED', 'Studio source snapshot has changed');
  let snapshot;
  try {
    snapshot = JSON.parse(sourceBytes.toString('utf8'));
  } catch {
    fail('STUDIO_SOURCE_REQUIRED', 'Studio source snapshot is not valid JSON');
  }
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot))
    fail('STUDIO_SOURCE_REQUIRED', 'Studio source snapshot must be an object');
  if (snapshot.enterprise?.id !== job.enterpriseId)
    fail(
      'STUDIO_ENTERPRISE_MISMATCH',
      'Studio job and native snapshot are from different enterprises',
    );
  if (job.input?.allowResearch !== true || snapshot.collectionAuthorized !== true) {
    fail(
      'STUDIO_WEBSITE_PERMISSION_REQUIRED',
      'The existing Studio job must authorize website capture',
    );
  }
  const company = snapshot.enterprise.company;
  if (
    !company ||
    !Number.isSafeInteger(company.revision) ||
    company.revision < 1 ||
    !Array.isArray(snapshot.products)
  ) {
    fail('STUDIO_REVISION_REQUIRED', 'Use a versioned native enterprise snapshot');
  }
  const products = snapshot.products;
  if (
    products.some(
      (p) =>
        !p ||
        typeof p.id !== 'string' ||
        !Number.isSafeInteger(p.revision) ||
        p.revision < 1 ||
        p.status !== 'draft',
    ) ||
    new Set(products.map((p) => p.id)).size !== products.length ||
    (job.input.productIds || []).some((id) => !products.some((p) => p.id === id))
  ) {
    fail(
      'STUDIO_PRODUCT_SNAPSHOT_INVALID',
      'Product IDs and revisions must match the frozen selection',
    );
  }
  const sourceBinding = {
    job_id: job.id,
    enterprise_id: job.enterpriseId,
    source_sha256: digest,
    company_revision: company.revision,
    product_revisions: products.map(({ id, revision }) => ({ id, revision })),
  };
  // Explicit allowlist: never pass internal SKUs, price tiers, supply policies,
  // document contents, contacts or unapproved photos into the site compiler.
  const result = await createSiteFromEnterprise(
    {
      enterprise: {
        id: job.enterpriseId,
        revision: 'studio-snapshot-' + digest,
        company: {
          displayName: company.displayName,
          legalName: company.legalName,
          description: company.description,
          website: company.website,
        },
        products: products.map(({ id, name, category, description }) => ({
          id,
          name,
          category,
          description,
        })),
      },
    },
    options,
  );
  return { ...result, source_binding: sourceBinding };
}

function defaultSlug(enterprise) {
  const name = String(enterprise?.company?.displayName || enterprise?.company?.legalName || '');
  const text = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 35);
  const fingerprint = createHash('sha256')
    .update(String(enterprise.id || ''))
    .digest('hex')
    .slice(0, 8);
  return 'buyer-' + (text || 'enterprise') + '-' + fingerprint;
}

/** The caller supplies an authenticated native-library export, never a browser-supplied tenant header. */
export async function createSiteFromEnterprise(
  exportData,
  { capture = captureCompanyHomepage, outputBase } = {},
) {
  if (!exportData || !exportData.enterprise || !exportData.enterprise.company) {
    throw new Error('Missing authenticated enterprise export');
  }
  const company = exportData.enterprise.company;
  if (!company.website) throw new Error('Enterprise profile has no company website');
  const snapshot = await capture(company.website);
  const request = {
    schema_version: '1.0.0',
    site_slug: exportData.site_slug || defaultSlug(exportData.enterprise),
    exported_at: new Date().toISOString(),
    enterprise: {
      id: exportData.enterprise.id,
      revision: exportData.enterprise.revision,
      company: exportData.enterprise.company,
      products: exportData.enterprise.products || [],
    },
    website_pages: [snapshot],
  };
  return writeSitePreview(request, outputBase);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const inputPath = process.argv[2];
  if (!inputPath) {
    console.error(
      'Usage: node site-builder/from-enterprise.mjs path/to/native-enterprise-export.json',
    );
    process.exitCode = 2;
  } else {
    try {
      const input = JSON.parse(await readFile(inputPath, 'utf8'));
      const result = await createSiteFromEnterprise(input);
      console.log(JSON.stringify(result, null, 2));
      console.log('Private preview only; build the generated edition using BUYERSITE_BUILD_ROOT.');
    } catch (error) {
      console.error('SITE_GENERATION_BLOCKED: ' + error.message);
      process.exitCode = 1;
    }
  }
}
