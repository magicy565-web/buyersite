const SAFE_BOT = /^[A-Za-z0-9_-]{1,128}$/;
const SAFE_THREAD = /^[\w-]{1,128}$/;
const MAX_RESPONSE_BYTES = 2_000_000;

export class OpenMausBotApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'OpenMausBotApiError';
    this.status = status;
    this.code = code;
  }
}

function normalizeOrigin(value) {
  let url;
  try { url = new URL(value); } catch { throw new TypeError('OpenMausBot base URL must be an absolute URL'); }
  const local = ['localhost','127.0.0.1','[::1]'].includes(url.hostname);
  if (!['https:','http:'].includes(url.protocol) || (url.protocol==='http:' && !local) ||
      url.username || url.password || url.search || url.hash || (url.pathname!=='/' && url.pathname!=='')) {
    throw new TypeError('OpenMausBot must use HTTPS (HTTP is allowed only on loopback)');
  }
  return url.origin;
}

function safeJsonPath(value) {
  if (typeof value!=='string' || value.length>300 || value.includes('\0') || value.includes('\\')) {
    throw new TypeError('Invalid OpenMausBot API path');
  }
  return value;
}

export function createOpenMausBotClient({
  baseUrl, token, fetchImpl = globalThis.fetch, timeoutMs = 20_000,
  maxResponseBytes = MAX_RESPONSE_BYTES,
} = {}) {
  const origin=normalizeOrigin(baseUrl);
  if(typeof token!=='string' || token.length<24 || token.length>4096 || /[\r\n]/.test(token)) {
    throw new TypeError('An OpenMausBot session token is required');
  }
  if(typeof fetchImpl!=='function' || !Number.isInteger(timeoutMs) || timeoutMs<1000 || timeoutMs>120_000 ||
     !Number.isInteger(maxResponseBytes) || maxResponseBytes<1024 || maxResponseBytes>MAX_RESPONSE_BYTES) {
    throw new TypeError('Invalid OpenMausBot client limits');
  }

  async function request(path,{method='GET',body,signal}={}) {
    const url=new URL(safeJsonPath(path),origin);
    const controller=new AbortController();
    const timer=setTimeout(()=>controller.abort(new Error('OpenMausBot request timed out')),timeoutMs);
    const abort=()=>controller.abort(signal.reason);
    if(signal?.aborted) abort(); else signal?.addEventListener('abort',abort,{once:true});
    try {
      const response=await fetchImpl(url,{
        method,
        redirect:'error',
        signal:controller.signal,
        headers:{
          accept:'application/json',
          authorization:'Bearer '+token,
          ...(body===undefined?{}:{'content-type':'application/json'}),
        },
        ...(body===undefined?{}:{body:JSON.stringify(body)}),
      });
      const bytes=Buffer.from(await response.arrayBuffer());
      if(bytes.length>maxResponseBytes) throw new OpenMausBotApiError(502,'RESPONSE_TOO_LARGE','OpenMausBot returned an oversized response');
      let data={};
      if(bytes.length){
        try{data=JSON.parse(bytes.toString('utf8'));}catch{throw new OpenMausBotApiError(502,'INVALID_RESPONSE','OpenMausBot returned invalid JSON');}
      }
      if(!response.ok) {
        const code=typeof data.code==='string'?data.code:'OPENMAUSBOT_REQUEST_FAILED';
        const message=typeof data.error==='string'?data.error.slice(0,400):'OpenMausBot request failed';
        throw new OpenMausBotApiError(response.status,code,message);
      }
      return data;
    } catch(error) {
      if(error instanceof OpenMausBotApiError) throw error;
      if(controller.signal.aborted) throw new OpenMausBotApiError(504,'OPENMAUSBOT_TIMEOUT','OpenMausBot request timed out or was cancelled');
      throw new OpenMausBotApiError(502,'OPENMAUSBOT_UNAVAILABLE','Could not reach the configured OpenMausBot host');
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort',abort);
    }
  }

  return Object.freeze({
    origin,
    async listBots() {
      const data=await request('/api/bots?messages=0');
      if(!Array.isArray(data.bots)) throw new OpenMausBotApiError(502,'BOT_ROSTER_INVALID','OpenMausBot returned no bot roster');
      return data.bots;
    },
    async importPackage(packageDocument) {
      return request('/api/teams/import?mode=add',{method:'POST',body:packageDocument});
    },
    async createTask(botId,title) {
      if(!SAFE_BOT.test(botId) || typeof title!=='string' || !title.trim() || title.length>100) {
        throw new TypeError('Invalid Bot task request');
      }
      const data=await request('/api/bots/'+encodeURIComponent(botId)+'/tasks',{
        method:'POST',body:{title,select:false,approvalMode:'ask'},
      });
      const threadId=data.task?.threadId;
      if(typeof threadId!=='string' || !SAFE_THREAD.test(threadId)) {
        throw new OpenMausBotApiError(502,'TASK_RECEIPT_INVALID','OpenMausBot did not return a valid task thread');
      }
      return {bot:data.bot,task:data.task,threadId};
    },
    async sendGoal(botId,threadId,text,sendId) {
      if(!SAFE_BOT.test(botId) || !SAFE_THREAD.test(threadId) ||
         typeof text!=='string' || !text.trim() || text.length>80_000 ||
         typeof sendId!=='string' || !/^[a-f0-9-]{36}$/i.test(sendId)) {
        throw new TypeError('Invalid OpenMausBot goal message');
      }
      return request('/api/bots/'+encodeURIComponent(botId)+'/messages',{
        method:'POST',body:{threadId,text,mode:'goal',sendId},
      });
    },
    async getJob(threadId,{since=0,wait=0,signal}={}) {
      if(!SAFE_THREAD.test(threadId) || !Number.isSafeInteger(since) || since<0 ||
         !Number.isInteger(wait) || wait<0 || wait>25_000) throw new TypeError('Invalid OpenMausBot job query');
      const query=new URLSearchParams({scope:'job',full:'1',since:String(since),wait:String(wait)});
      return request('/api/threads/'+encodeURIComponent(threadId)+'/job?'+query,{signal});
    },
    async getMessages(threadId,{limit=100}={}) {
      if(!SAFE_THREAD.test(threadId) || !Number.isInteger(limit) || limit<1 || limit>200) throw new TypeError('Invalid message query');
      const query=new URLSearchParams({limit:String(limit)});
      const data=await request('/api/threads/'+encodeURIComponent(threadId)+'/messages?'+query);
      if(!Array.isArray(data.messages)) throw new OpenMausBotApiError(502,'MESSAGE_PAGE_INVALID','OpenMausBot returned an invalid message page');
      return data.messages;
    },
  });
}