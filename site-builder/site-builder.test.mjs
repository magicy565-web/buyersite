import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compileEnterpriseSite, SiteInputError } from './compile.mjs';
import { writeSitePreview } from './build.mjs';

const body =
  'Product: test upholstery textile\nMaterial: cotton\nThis example page shows sample text for contract validation only. No real factory or product is represented.';
const hash = createHash('sha256').update(body).digest('hex');
function input() {
  return {
    schema_version: '1.0.0',
    site_slug: 'sample-buyer-review',
    exported_at: '2026-11-13T00:00:00Z',
    enterprise: {
      id: 'synthetic-enterprise-1',
      revision: 7,
      company: {
        displayName: 'Example Textile Works',
        description:
          'A synthetic profile used to exercise the site builder. No real factory is represented.',
        website: 'https://example.com',
      },
      products: [
        {
          id: 'product-1',
          name: 'test upholstery textile',
          category: 'Textiles',
          description: 'A synthetic product record for exercising source and build rules.',
        },
      ],
    },
    website_pages: [
      {
        url: 'https://example.com/products/test',
        title: 'Synthetic source page',
        body_text: body,
        content_sha256: hash,
        captured_at: '2026-11-12T12:00:00Z',
      },
    ],
  };
}
function fails(code, fn) {
  assert.throws(fn, (error) => error instanceof SiteInputError && error.code === code);
}

test('generates source-backed private publication contracts, not claims of deployment', () => {
  const result = compileEnterpriseSite(input());
  assert.equal(result.manifest.assistant.enabled, false);
  assert.equal(result.site.privatePreview, true);
  assert.ok(result.manifest.routes.every((route) => route.indexable === false));
  assert.equal(result.evidence.filter((item) => item.source_url).length, 1);
  assert.equal(result.articles.filter((item) => item.pageType === 'product-editorial').length, 1);
  assert.ok(
    result.pages
      .find((item) => item.page_type === 'product-editorial')
      .evidence_refs.includes('website-1'),
  );
  assert.ok(result.publication_blockers.includes('CONVERSION_BACKEND_UNVERIFIED'));
  assert.ok(!JSON.stringify(result).includes('verified certification'));
});

test('rejects missing capture, unrelated domains and falsified snapshot hashes', () => {
  const missing = input();
  missing.website_pages = [];
  fails('WEBSITE_CAPTURE_REQUIRED', () => compileEnterpriseSite(missing));
  const cross = input();
  cross.website_pages[0].url = 'https://other.example.com/products/test';
  fails('CROSS_DOMAIN_SOURCE', () => compileEnterpriseSite(cross));
  const altered = input();
  altered.website_pages[0].body_text += ' silently changed';
  fails('SOURCE_HASH_MISMATCH', () => compileEnterpriseSite(altered));
});

test('protects against unsafe source URLs and unsupported versions', () => {
  const unsafe = input();
  unsafe.enterprise.company.website = 'http://127.0.0.1/admin';
  fails('INVALID_URL', () => compileEnterpriseSite(unsafe));
  const bad = input();
  bad.schema_version = '2.0.0';
  fails('SCHEMA_VERSION', () => compileEnterpriseSite(bad));
});

test('empty product library still yields honest supplier profile and enquiry guidance', () => {
  const noProducts = input();
  noProducts.enterprise.products = [];
  const result = compileEnterpriseSite(noProducts);
  assert.equal(result.articles.length, 2);
  assert.ok(result.articles.some((page) => page.pageType === 'buyer-guide'));
});

test('writes isolated Astro content with escaped source text and immutable hash directory', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'buyer-site-'));
  try {
    const fixture = input();
    fixture.enterprise.company.description = '<script>alert(1)</script> Example & text';
    const generated = await writeSitePreview(fixture, dir);
    const files = await readFile(
      join(generated.root, 'articles', 'example-textile-works.md'),
      'utf8',
    );
    assert.ok(files.includes('&lt;script&gt;'));
    assert.ok(!files.includes('<script>'));
    assert.ok(files.includes('hero: "./cover.png"'));
    const cover = await readFile(join(generated.root, 'articles', 'cover.png'));
    assert.equal(cover.subarray(1, 4).toString(), 'PNG');
    const receipt = JSON.parse(await readFile(join(generated.root, 'receipt.json'), 'utf8'));
    assert.equal(receipt.preview_only, true);
    assert.equal(receipt.enterprise_revision, 7);
    const repeated = await writeSitePreview(fixture, dir);
    assert.equal(generated.root, repeated.root);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
