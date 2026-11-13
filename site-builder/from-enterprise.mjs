import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { captureCompanyHomepage } from './capture.mjs';
import { writeSitePreview } from './build.mjs';

function defaultSlug(enterprise) {
  const name = String(enterprise?.company?.displayName || enterprise?.company?.legalName || '');
  const text = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 35);
  const fingerprint = createHash('sha256').update(String(enterprise.id || '')).digest('hex').slice(0, 8);
  return 'buyer-' + (text || 'enterprise') + '-' + fingerprint;
}

/** The caller supplies an authenticated native-library export, never a browser-supplied tenant header. */
export async function createSiteFromEnterprise(exportData, { capture = captureCompanyHomepage, outputBase } = {}) {
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
    console.error('Usage: node site-builder/from-enterprise.mjs path/to/native-enterprise-export.json');
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
