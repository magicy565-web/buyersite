import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const pages = JSON.parse(await readFile('.generated/pages.json','utf8'));
const evidence=JSON.parse(await readFile('src/data/evidence.json','utf8'));
for(const page of pages){
 const file='dist'+(page.path==='/'?'/index.html':page.path+'index.html'); const html=await readFile(file,'utf8');
 assert.match(html,/<meta name="robots" content="noindex, nofollow"/); assert.ok(html.includes('rel="canonical"')); assert.ok(html.includes('<h1')); assert.ok(html.includes(page.h1));
 if(page.path!=='/')for(const id of page.evidence_refs){const record=evidence.find(e=>e.evidence_id===id);assert.ok(record);assert.ok(html.includes(record.claim));assert.ok(html.includes(record.value));assert.ok(html.includes(record.source_url));}
 assert.ok(!html.includes('Linnea Holm'));
}
assert.match(await readFile('dist/robots.txt','utf8'),/Disallow: \//);
assert.match(await readFile('dist/enquiry/index.html','utf8'),/Nothing is sent/);
assert.ok(await readFile('dist/sitemap-index.xml','utf8'));
console.log('Verified built HTML for '+pages.length+' core routes, noindex, canonical, H1, enquiry scope, robots and sitemap. No deployment or bot-access claim.');
