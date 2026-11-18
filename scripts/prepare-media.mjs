import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
if (process.env.BUYERSITE_BUILD_ROOT) {
  console.log('Enterprise media is resolved by the tenant-bound media pipeline.');
  process.exit(0);
}
const registry=JSON.parse(await readFile('src/data/concept-media.json','utf8'));
if(registry.assets.length!==3)throw Error('Pilot requires three reviewed concept assets');
for(const asset of registry.assets){
  if(!/^src\/assets\/concepts\/[a-z-]+\.png$/.test(asset.file))throw Error('Unsafe concept path');
  const bytes=await readFile(asset.file);
  const digest=createHash('sha256').update(bytes).digest('hex');
  if(createHash('sha256').update(asset.prompt).digest('hex')!==asset.prompt_sha256)throw Error('Concept prompt provenance changed');
  if(digest!==asset.sha256||asset.kind!=='ai-generated'||asset.review?.status!=='accepted-concept-image')throw Error('Concept media provenance changed');
  const metadata=await sharp(bytes).metadata();
  if(metadata.format!=='png'||metadata.width<1000||metadata.height<600)throw Error('Concept image resolution too low');
  const article=await readFile('src/content/articles/'+asset.page_id+'.md','utf8');
  const imageName=asset.file.split('/').at(-1);
  if(!article.includes('hero: "../../assets/concepts/'+imageName+'"'))throw Error('Concept hero binding changed');
  if(!article.includes(asset.credit)||!article.includes(asset.caption))throw Error('Concept image disclosure is missing');
}
console.log('Verified three original AI concept images, hashes and visible disclosures. No supplier photography fetched.');
