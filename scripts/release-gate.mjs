import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { verifyPublicationMedia } from './prepare-media.mjs';
export async function releaseFingerprint(){
  const files=[];
  for(const root of ['src','runtime','scripts','site-builder']){
    for(const name of (await readdir(root,{recursive:true,withFileTypes:true})).filter(x=>x.isFile())){
      // POSIX separators keep the fingerprint identical on Windows and Linux checkouts.
      const file=join(name.parentPath,name.name).split(sep).join("/");
      if(file.endsWith('.test.mjs')||file==='src/data/publication.json'||file.startsWith('src/assets/review/'))continue;
      files.push(file);
    }
  }
  files.push('astro.config.mjs','package.json','pnpm-lock.yaml','.openai/hosting.json');
  const rows=[];
  for(const file of files.sort())rows.push([file,createHash('sha256').update(await readFile(file)).digest('hex')]);
  const publication=JSON.parse(await readFile('src/data/publication.json','utf8'));
  const{mode,reviewReport,...settings}=publication;
  return createHash('sha256').update(JSON.stringify({rows,settings})).digest('hex');
}
export async function assertPublicRelease(){
  if(process.env.BUYERSITE_BUILD_ROOT)return;
  const settings=JSON.parse(await readFile('src/data/publication.json','utf8'));
  if(settings.mode!=='public')return;
  await verifyPublicationMedia();
  const report=JSON.parse(await readFile(settings.reviewReport,'utf8'));
  if(report.status!=='APPROVED_EDITORIAL_RELEASE'||report.source_sha256!==await releaseFingerprint())throw Error('PUBLIC_RELEASE_REVIEW_STALE: review the exact source before enabling indexing');
  if(report.visual_review?.complete!==true||report.visual_review?.decision!=='pass'||report.visual_review?.unresolved_blocking_findings!==0||report.conversion?.persisted_receipt_verified!==true||settings.enquiriesEnabled!==true)throw Error('PUBLIC_RELEASE_INCOMPLETE');
  const pilot=JSON.parse(await readFile('src/data/pilot.json','utf8'));
  const expected=['/',...pilot.articles.map(a=>'/'+a.desk+'/'+a.slug+'/'),'/enquiry/','/search/','/sources/','/colophon/','/privacy/'];
  const reviewed=new Set(report.visual_review.reviewed_paths);
  if(expected.some(p=>!reviewed.has(p)))throw Error('PUBLIC_RELEASE_REVIEW_INCOMPLETE');
  const evidence=JSON.parse(await readFile('src/data/evidence.json','utf8'));
  if(evidence.some(x=>x.publication_permission!=='approved'))throw Error('PUBLIC_EVIDENCE_UNAPPROVED');
}
