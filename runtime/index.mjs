import { createGateway } from './gateway.mjs';
import { handleAnalytics } from './analytics.mjs';
import { handleFeedback } from './feedback.mjs';
import { createMerchantRoutes } from './merchant-routes.mjs';
import { dispatchMarketingOutbox } from './marketing-outbox.mjs';
import { createScheduledHandler } from './scheduled.mjs';
import config from '../.generated/runtime-config.json';
const gateway=createGateway(config);
const merchantRoutes=createMerchantRoutes(config);
export default {
  async fetch(request,env,ctx){
    const path=new URL(request.url).pathname;
    const merchantResponse=await merchantRoutes.fetch(request,env,ctx);
    const response=merchantResponse??(path==='/api/events'?await handleAnalytics(request,env,config):path==='/api/buyer/admin/feedback'?await handleFeedback(request,env,config):await gateway.fetch(request,env,ctx));
    const headers=new Headers(response.headers);
    headers.set('X-Content-Type-Options','nosniff');
    headers.set('Referrer-Policy','strict-origin-when-cross-origin');
    headers.set('Permissions-Policy','camera=(), microphone=(), geolocation=()');
    if(config.publication!=='public'||path.startsWith('/api/')||path==='/mcp'||path.startsWith('/.well-known/oauth-'))headers.set('X-Robots-Tag','noindex, nofollow');
    if(path.startsWith('/api/')||path==='/mcp'||path.startsWith('/.well-known/oauth-'))headers.set('Cache-Control','no-store');
    return new Response(response.body,{status:response.status,statusText:response.statusText,headers});
  },
  scheduled:createScheduledHandler(config,{
    drainMerchant:merchantRoutes.scheduled,
    dispatchMarketing:dispatchMarketingOutbox,
  }),
};
