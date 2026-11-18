const events=new Set(['page_view','article_opened','enquiry_started','enquiry_submitted','assistant_opened','search_used','source_opened']);
const reply=(status)=>new Response(null,{status,headers:{'Cache-Control':'no-store'}});
export async function handleAnalytics(request,env,config){
  if(request.method!=='POST')return reply(405);
  const origin=new URL(request.url).origin;
  if(request.headers.get('origin')!==origin||request.headers.get('sec-fetch-site')==='cross-site')return reply(403);
  if(!config.analyticsEnabled||!env.DB||request.headers.get('DNT')==='1'||request.headers.get('Sec-GPC')==='1')return reply(204);
  if(!request.headers.get('content-type')?.startsWith('application/json'))return reply(415);
  const reader=request.body?.getReader();if(!reader)return reply(400);
  let size=0;const chunks=[];
  try{while(true){const{value,done}=await reader.read();if(done)break;size+=value.length;if(size>1024){await reader.cancel();return reply(413);}chunks.push(value);}}finally{reader.releaseLock();}
  let body;try{const bytes=new Uint8Array(size);let offset=0;for(const c of chunks){bytes.set(c,offset);offset+=c.length;}body=JSON.parse(new TextDecoder().decode(bytes));}catch{return reply(400);}
  if(!body||typeof body!=='object'||Array.isArray(body))return reply(400);
  const allowed=new Set(config.allowedPaths.map(p=>p.replace(/\/+$/,'')||'/'));
  const path=typeof body.path==='string'?body.path.replace(/\/+$/,'')||'/':'';
  if(!events.has(body.name)||!allowed.has(path)||Object.keys(body).some(k=>!['name','path'].includes(k)))return reply(400);
  const now=Date.now();const minute=Math.floor(now/60000);const ip=request.headers.get('CF-Connecting-IP')||'local';
  const digest=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(`${config.siteSlug}:${minute}:${ip}`)));
  const bucket=Array.from(digest,x=>x.toString(16).padStart(2,'0')).join('');
  try{
    const rate=await env.DB.prepare("INSERT INTO buyer_rate_limits(site_slug,scope,bucket,window_start,count,expires_at) VALUES (?,'events',?,?,1,?) ON CONFLICT(site_slug,scope,bucket,window_start) DO UPDATE SET count=count+1 WHERE count<60 RETURNING count").bind(config.siteSlug,bucket,minute,Math.floor(now/1000)+120).first();
    if(!rate)return reply(429);
    await env.DB.prepare('INSERT INTO buyer_event_daily(site_slug,day,event,path,count) VALUES(?,?,?,?,1) ON CONFLICT(site_slug,day,event,path) DO UPDATE SET count=count+1').bind(config.siteSlug,new Date(now).toISOString().slice(0,10),body.name,path).run();
    await env.DB.prepare('DELETE FROM buyer_rate_limits WHERE rowid IN (SELECT rowid FROM buyer_rate_limits WHERE expires_at<? LIMIT 50)').bind(Math.floor(now/1000)).run();
    return reply(204);
  }catch{return reply(503);}
}
