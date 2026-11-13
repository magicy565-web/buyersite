import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import pilot from '../src/data/pilot.json' with { type: 'json' };
if (process.env.BUYERSITE_BUILD_ROOT) {
  console.log('Enterprise edition: only original generated artwork is used; no pilot supplier photos fetched.');
  process.exit(0);
}
await mkdir('src/assets/review', { recursive: true });
for (const asset of pilot.media) {
  const url = new URL(asset.url);
  if (url.protocol !== 'https:' || url.hostname !== 'cdn.shopify.com' || !/^[a-z-]+\.jpg$/.test(asset.file)) throw Error('Unapproved media URL or path');
  const response = await fetch(url);
  if (!response.ok || !response.headers.get('content-type')?.startsWith('image/')) throw Error('Media fetch failed');
  const bytes = Buffer.from(await response.arrayBuffer());
  if(bytes.length > 8 * 1024 * 1024) throw Error('Media too large');
  await writeFile('src/assets/review/' + asset.file, bytes);
  await writeFile('src/assets/review/receipt.json', JSON.stringify({ source_url: asset.source_url, url:asset.url, captured_at:new Date().toISOString(), sha256:createHash('sha256').update(bytes).digest('hex'), permission:asset.permission }, null, 2));
}
