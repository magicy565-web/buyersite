import { createGateway } from './gateway.mjs';
import { handleAnalytics } from './analytics.mjs';
import { handleFeedback } from './feedback.mjs';
import config from '../.generated/runtime-config.json';
const gateway=createGateway(config);
export default {
  async fetch(request,env,ctx){
    const path=new URL(request.url).pathname;
    const response=path==='/api/events'?await handleAnalytics(request,env,config):path==='/api/buyer/admin/feedback'?await handleFeedback(request,env,config):await gateway.fetch(request,env,ctx);
    const headers=new Headers(response.headers);
    headers.set('X-Content-Type-Options','nosniff');
    headers.set('Referrer-Policy','strict-origin-when-cross-origin');
    headers.set('Permissions-Policy','camera=(), microphone=(), geolocation=()');
    if(config.publication!=='public'||path.startsWith('/api/'))headers.set('X-Robots-Tag','noindex, nofollow');
    if(path.startsWith('/api/'))headers.set('Cache-Control','no-store');
    return new Response(response.body,{status:response.status,statusText:response.statusText,headers});
  }
};
