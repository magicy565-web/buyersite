import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const edition = process.env.BUYERSITE_BUILD_ROOT;
const pages = JSON.parse(await readFile(edition ? edition + '/pages.json' : '.generated/pages.json', 'utf8'));
const evidence = JSON.parse(await readFile(edition ? edition + '/evidence.json' : 'src/data/evidence.json', 'utf8'));
const escaped = (value) => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
for (const page of pages) {
  const file = 'dist' + (page.path === '/' ? '/index.html' : page.path + 'index.html');
  const html = await readFile(file, 'utf8');
  assert.match(html, /<meta name="robots" content="noindex, nofollow"/);
  assert.ok(html.includes('rel="canonical"'));
  const headings = [...html.matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1>/g)].map((match) =>
    match[1].replace(/<[^>]*>/g, '').trim(),
  );
  assert.equal(headings.length, 1);
  assert.equal(headings[0], page.h1);
  if (page.path !== '/') {
    for (const id of page.evidence_refs) {
      const record = evidence.find((item) => item.evidence_id === id);
      assert.ok(record, 'missing evidence ' + id);
      assert.ok(html.includes(escaped(record.claim)), 'missing claim ' + id);
      assert.ok(html.includes(escaped(record.value)), 'missing evidence value ' + id);
      if (record.source_url) assert.ok(html.includes(record.source_url));
    }
  }
  assert.ok(!html.includes('Linnea Holm'));
  assert.ok(html.includes('href="/enquiry"'));
  if (page.page_type === 'product-editorial')
    assert.ok(html.indexOf('id="spec-summary-title"') < html.indexOf('class="article-body'));
}
assert.match(await readFile('dist/robots.txt', 'utf8'), /Disallow: \//);
assert.match(await readFile('dist/enquiry/index.html', 'utf8'), /Nothing is sent/);
assert.ok(await readFile('dist/sitemap-index.xml', 'utf8'));
console.log('Verified built private preview for ' + pages.length + ' routes, source notes, noindex, enquiry and robots. This is not publication acceptance.');
