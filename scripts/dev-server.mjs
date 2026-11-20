// Development adapter only. Production uses the bundled Worker and hosted D1.
import { createServer } from 'node:http';
import { readFile, mkdir, readdir, stat } from 'node:fs/promises';
import { resolve, join, extname, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
const edition=process.env.BUYERSITE_BUILD_ROOT;
let worker,DB;
if(!edition){
  worker=(await import('../dist/server/index.js')).default;
  await mkdir('.generated',{recursive:true});
  const sqlite=new DatabaseSync('.generated/dev-inbox.sqlite');
  sqlite.exec('CREATE TABLE IF NOT EXISTS _local_migrations(name TEXT PRIMARY KEY)');
  for(const name of (await readdir('drizzle')).filter(x=>x.endsWith('.sql')).sort()){
    if(!sqlite.prepare('SELECT name FROM _local_migrations WHERE name=?').get(name)){
      sqlite.exec(await readFile(join('drizzle',name),'utf8'));
      sqlite.prepare('INSERT INTO _local_migrations(name) VALUES(?)').run(name);
    }
  }
  const wrap=(sql,args=[])=>({bind(...values){return wrap(sql,values);},async first(){return sqlite.prepare(sql).get(...args)||null;},async all(){return {success:true,results:sqlite.prepare(sql).all(...args)};},async run(){const r=sqlite.prepare(sql).run(...args);return {success:true,meta:{changes:r.changes,last_row_id:r.lastInsertRowid}};}});
  DB={prepare:sql=>wrap(sql),async batch(statements){
    sqlite.exec('BEGIN');
    try{
      const results=[];
      for(const statement of statements)results.push(await statement.all());
      sqlite.exec('COMMIT');return results;
    }catch(error){sqlite.exec('ROLLBACK');throw error;}
  }};
}
const staticRoot=resolve(edition?'dist':'dist/client');
const MIME={'.html':'text/html; charset=utf-8','.css':'text/css','.js':'text/javascript','.json':'application/json','.png':'image/png','.webp':'image/webp','.avif':'image/avif','.ico':'image/x-icon','.jpg':'image/jpeg','.svg':'image/svg+xml','.woff2':'font/woff2','.wasm':'application/wasm','.xml':'application/xml','.txt':'text/plain'};
const ASSETS={async fetch(request){
  let pathname;try{pathname=decodeURIComponent(new URL(request.url).pathname);}catch{return new Response('Bad path',{status:400});}
  const target=resolve(staticRoot,'.'+pathname);if(target!==staticRoot&&!target.startsWith(staticRoot+sep))return new Response('Not found',{status:404});
  let file=target;const info=await stat(file).catch(()=>null);if(info?.isDirectory())file=join(file,'index.html');
  try{return new Response(await readFile(file),{headers:{'Content-Type':MIME[extname(file)]||'application/octet-stream'}});}catch{return new Response(await readFile(join(staticRoot,'404.html')).catch(()=>'Not found'),{status:404,headers:{'Content-Type':'text/html; charset=utf-8'}});}
}};
const reviewPaths=edition
  ?new Set((await readdir(staticRoot,{recursive:true})).map(String).filter(file=>file.endsWith('index.html')).map(file=>('/'+file.replace(/index\.html$/,'').replaceAll('\\','/')).replace(/\/+$/,'')||'/'))
  :new Set(JSON.parse(await readFile('.generated/runtime-config.json','utf8')).allowedPaths.map(p=>p.replace(/\/+$/,'')||'/'));
const args=process.argv.slice(2);const pi=args.indexOf('--port');const port=Number(process.env.PORT||process.env.SITES_PORT||(pi>=0?args[pi+1]:4321));
const server=createServer(async(req,res)=>{
  try{
    if((req.url||'').startsWith('/__review?')){
      const query=new URL(req.url,'http://preview.local').searchParams;
      const width=Number(query.get('width'))===1440?1440:Number(query.get('width'))===390?390:360;
      const target=query.get('path')||'/';
      if(!reviewPaths.has(target.replace(/\/+$/,'')||'/')){res.writeHead(404);res.end();return;}
      const escaped=target.replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;');
      res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','X-Robots-Tag':'noindex'});
      res.end(`<!doctype html><html><head><title>Buyersite layout review ${width}px</title><meta name="robots" content="noindex"><style>body{margin:0;background:#ddd;font:14px system-ui;}p{margin:10px 16px;}iframe{display:block;width:${width}px;height:844px;border:0;margin:0 auto;background:white;}</style></head><body><p>Layout review · ${width}px · ${escaped}</p><iframe title="Buyersite responsive preview" src="${escaped}"></iframe></body></html>`);return;
    }
    const origin=req.headers.origin;const host=req.headers.host||'localhost:'+port;
    const proto=origin&&new URL(origin).host===host?new URL(origin).protocol.replace(':',''):req.headers['x-forwarded-proto']||'http';
    const url=`${proto}://${host}${req.url}`;const body=[];let size=0;
    for await(const chunk of req){size+=chunk.length;if(size>20000){res.writeHead(413);res.end();return;}body.push(chunk);}
    const request=new Request(url,{method:req.method,headers:req.headers,...(!['GET','HEAD'].includes(req.method)?{body:Buffer.concat(body)}:{})});
    const response=edition
      ?(['GET','HEAD'].includes(req.method)?await ASSETS.fetch(request):new Response('Method not allowed',{status:405,headers:{Allow:'GET, HEAD'}}))
      :await worker.fetch(request,{DB,ASSETS},{waitUntil:p=>p.catch(()=>{})});
    const headers=new Headers(response.headers);
    if(edition){headers.set('X-Robots-Tag','noindex, nofollow, noarchive');headers.set('Cache-Control','private, no-store');}
    res.writeHead(response.status,Object.fromEntries(headers));res.end(req.method==='HEAD'?undefined:Buffer.from(await response.arrayBuffer()));
  }catch{res.writeHead(500);res.end('Preview request failed');}
});
server.listen(port,'0.0.0.0',()=>console.log(`Buyersite preview on port ${port}`));
