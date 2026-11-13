import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

const edition = process.env.BUYERSITE_BUILD_ROOT;
const pages = JSON.parse(
  await readFile(edition ? join(edition, 'pages.json') : '.generated/pages.json', 'utf8'),
);
const evidence = JSON.parse(
  await readFile(edition ? join(edition, 'evidence.json') : 'src/data/evidence.json', 'utf8'),
);
const escaped = (value) =>
  String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
const decoded = (value) =>
  value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|#39);/gi, (entity, key) => {
    if (key[0] === '#')
      return String.fromCodePoint(
        key[1].toLowerCase() === 'x' ? parseInt(key.slice(2), 16) : Number(key.slice(1)),
      );
    return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[key.toLowerCase()] ?? entity;
  });
for (const page of pages) {
  const file = 'dist' + (page.path === '/' ? '/index.html' : page.path + 'index.html');
  const html = await readFile(file, 'utf8');
  const headings = [...html.matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1>/g)].map((match) =>
    decoded(match[1].replace(/<[^>]*>/g, '').trim()),
  );
  assert.equal(headings.length, 1, file + ': one H1');
  assert.equal(headings[0], page.h1, file + ': page contract H1');
  if (page.path !== '/') {
    for (const id of page.evidence_refs) {
      const record = evidence.find((item) => item.evidence_id === id);
      assert.ok(record, 'missing evidence ' + id);
      const visible = decoded(html.replace(/<[^>]*>/g, ''));
      assert.ok(visible.includes(record.claim), 'missing claim ' + id);
      assert.ok(visible.includes(record.value), 'missing evidence value ' + id);
      if (record.source_url)
        assert.ok(html.includes(escaped(record.source_url)), 'missing source URL ' + id);
    }
  }
  assert.ok(html.includes('href="/enquiry"'));
  if (page.page_type === 'product-editorial') {
    const summary = html.indexOf('id="spec-summary-title"');
    const body = html.indexOf('class="article-body');
    assert.ok(summary >= 0 && body > summary, 'product specifications must precede the article');
  }
}
const files = (await readdir('dist', { recursive: true })).map(String);
const htmlFiles = files.filter((file) => file.endsWith('.html'));
for (const file of htmlFiles) {
  const html = await readFile(join('dist', file), 'utf8');
  assert.match(html, /<meta name="robots" content="noindex, nofollow"/, file + ': noindex');
  assert.match(html, /rel="canonical"/, file + ': canonical');
  assert.ok(!html.includes('Linnea Holm'), file + ': no theme demo author');
  if (edition)
    assert.doesNotMatch(
      html,
      /Burel Factory|burel-silver|burelfactory\.com/i,
      file + ': no pilot data',
    );
  for (const script of html.matchAll(
    /<script\b[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g,
  ))
    JSON.parse(script[1]);
  // Internal links must resolve to a file in this exact build, including assets.
  for (const [, attribute] of html.matchAll(/(?:href|src)="(\/(?!\/)[^"]*)"/g)) {
    const pathname = new URL(decoded(attribute), 'https://buyer-magazine.invalid').pathname;
    assert.ok(!pathname.includes('..'), 'unsafe built path');
    const target = join('dist', decodeURIComponent(pathname));
    const info = await stat(target).catch(() => null);
    assert.ok(info, file + ': missing local target ' + pathname);
    if (info.isDirectory()) assert.ok((await stat(join(target, 'index.html'))).isFile());
  }
}
if (edition) {
  for (const file of files.filter((file) => /\.(xml|json|js|css|txt)$/.test(file))) {
    assert.doesNotMatch(
      await readFile(join('dist', file), 'utf8'),
      /Burel Factory|burel-silver|burelfactory\.com/i,
      file + ': no pilot data',
    );
  }
}
assert.match(await readFile('dist/robots.txt', 'utf8'), /Disallow: \//);
assert.match(await readFile('dist/enquiry/index.html', 'utf8'), /Nothing is sent/);
assert.ok(await readFile('dist/sitemap-index.xml', 'utf8'));
console.log(
  'Verified ' +
    pages.length +
    ' core routes and all ' +
    htmlFiles.length +
    ' HTML files: evidence, private indexing, canonical, structured data, local links/assets and enquiry. Not publication acceptance.',
);
