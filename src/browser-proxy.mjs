import {createHmac, randomBytes, timingSafeEqual} from 'node:crypto';
import {AudioError} from './errors.mjs';
import {relayAudioChunks} from './relay.mjs';

const allowedHeaders = new Set(['accept','accept-language','content-type','user-agent','x-goog-visitor-id','x-youtube-client-name','x-youtube-client-version','x-goog-api-format-version']);
const fail = (code,message,status=400) => new AudioError(code,message,status,false,'browser_proxy');

export function validateProxyRequest(input) {
  if (!input || typeof input.url!=='string' || input.url.length>8192) throw fail('INVALID_PROXY_REQUEST','Invalid YouTube request.');
  let url;try{url=new URL(input.url);}catch{throw fail('INVALID_PROXY_REQUEST','Invalid YouTube request.');}
  if(url.protocol!=='https:'||url.port||url.username||url.password||url.hash||!['www.youtube.com','music.youtube.com'].includes(url.hostname))throw fail('PROXY_TARGET_REJECTED','This proxy accepts only supported YouTube requests.',403);
  const method=input.method||'GET';
  const read=method==='GET'&&(url.pathname==='/'||url.pathname==='/sw.js_data'||/^\/s\/player\/[a-zA-Z0-9_-]{4,64}\/player_(?:es6|ias)\.vflset\/[a-zA-Z_]{2,12}\/base\.js$/.test(url.pathname));
  const api=method==='POST'&&/^\/youtubei\/v1\/(player|next|search|browse)$/.test(url.pathname);
  if(!read&&!api)throw fail('PROXY_TARGET_REJECTED','This YouTube operation is not supported.',403);
  if(input.body!=null&&(typeof input.body!=='string'||Buffer.byteLength(input.body)>131072))throw fail('PROXY_BODY_TOO_LARGE','The YouTube request is too large.',413);
  if(read&&input.body)throw fail('INVALID_PROXY_REQUEST','GET requests cannot contain a body.');
  if(api){let data;try{data=JSON.parse(input.body);}catch{throw fail('INVALID_PROXY_REQUEST','YouTube API requests must contain JSON.');}if(!data||typeof data!=='object'||Array.isArray(data))throw fail('INVALID_PROXY_REQUEST','Invalid YouTube API request.');}
  const headers={'Accept-Encoding':'identity',Origin:url.origin,Referer:url.origin+'/'};
  if(input.headers && (typeof input.headers!=='object'||Array.isArray(input.headers)))throw fail('INVALID_PROXY_REQUEST','Invalid request headers.');
  for(const [name,value]of Object.entries(input.headers||{}))if(allowedHeaders.has(name.toLowerCase())&&typeof value==='string'&&value.length<=2048&&!/[\r\n]/.test(value))headers[name.toLowerCase()]=value;
  if(api)headers['content-type']='application/json';
  return{url,method,headers,body:api?input.body:undefined};
}

export function validateBrowserAudio(input,now=Date.now()) {
  if(!input||typeof input.url!=='string'||input.url.length>12000||!/^[A-Za-z0-9_-]{11}$/.test(input.videoId))throw fail('INVALID_AUDIO_SOURCE','Invalid browser audio source.');
  let url;try{url=new URL(input.url);}catch{throw fail('INVALID_AUDIO_SOURCE','Invalid browser audio source.');}
  const mimeType=url.searchParams.get('mime');
  if(url.protocol!=='https:'||url.username||url.password||url.port||url.hash||!url.hostname.endsWith('.googlevideo.com')||url.pathname!=='/videoplayback'||!['audio/mp4','audio/webm'].includes(mimeType)||mimeType!==input.mimeType)throw fail('NON_AUDIO_SOURCE','Only direct YouTube audio-only sources are accepted.',422);
  const bytes=Number(url.searchParams.get('clen')),expiry=Number(url.searchParams.get('expire'))*1000;
  if(!Number.isSafeInteger(bytes)||bytes<1||bytes>100*1024*1024||!Number.isFinite(expiry)||expiry<now+30000)throw fail('AUDIO_SOURCE_EXPIRED','This audio source is missing its length or has expired. Resolve the recording again.',422);
  const headers={Origin:'https://www.youtube.com',Referer:'https://www.youtube.com/'};
  if(typeof input.userAgent==='string'&&input.userAgent.length<=512&&!/[\r\n]/.test(input.userAgent))headers['User-Agent']=input.userAgent;
  return {id:input.videoId,sourceUrl:url.href,mimeType,headers,formatId:String(url.searchParams.get('itag')||''),sourceExpiresAt:expiry,expiresAt:Math.min(now+300000,expiry-30000)};
}

export class BrowserYoutubeProxy {
  constructor({fetchImpl=fetch,signingKey,publicBaseURL,allowedOrigin,now=Date.now}={}){this.fetch=fetchImpl;this.secret=signingKey;this.base=publicBaseURL;this.origin=allowedOrigin;this.now=now;this.sources=new Map();this.pause=null;this.active=0;this.requests=0;}
  availability(){if(this.pause?.retryAt<=this.now())this.pause=null;return this.pause?{available:false,code:this.pause.code,message:this.pause.message,retryAt:this.pause.retryAt}:{available:true};}
  check(){if(!this.availability().available)throw this.pause;}
  block(code,message,status){const error=fail(code,message,status);error.retryAt=this.now()+600000;this.pause=error;return error;}
  async request(input){
    const request=validateProxyRequest(input);this.check();
    if(this.requests>=4)throw fail('PROXY_BUSY','The YouTube proxy is busy. Try again shortly.',503);
    this.requests++;
    try{return await this.forward(request);}finally{this.requests--;}
  }
  async forward(request){
    let response;
    try{response=await this.fetch(request.url,{method:request.method,headers:request.headers,body:request.body,redirect:'manual',signal:AbortSignal.timeout(30000)});}catch{throw fail('PROXY_NETWORK_ERROR','The YouTube proxy connection failed or timed out.',504);}
    if(response.status===429){await response.body?.cancel();throw this.block('UPSTREAM_RATE_LIMIT','YouTube is rate-limiting this server. New requests are paused for 10 minutes.',429);}
    if(response.status>=300&&response.status<400){await response.body?.cancel();throw fail('PROXY_REDIRECT_REJECTED','YouTube redirected this request. The proxy did not follow it.',502);}
    const chunks=[];let bytes=0;
    try{for await(const part of response.body||[]){bytes+=part.length;if(bytes>6*1024*1024)throw fail('PROXY_RESPONSE_TOO_LARGE','The YouTube response exceeded its size limit.',502);chunks.push(Buffer.from(part));}}catch(error){if(error instanceof AudioError)throw error;throw fail('PROXY_NETWORK_ERROR','The YouTube proxy response was interrupted.',504);}
    const data=Buffer.concat(chunks);
    if(request.url.pathname.endsWith('/player')){
      let parsed;try{parsed=JSON.parse(data.toString());}catch{}
      const status=parsed?.playabilityStatus;
      if(status?.status==='LOGIN_REQUIRED'||/confirm.*not a bot|unusual traffic/i.test(status?.reason||''))throw this.block('PROVIDER_VERIFICATION_REQUIRED','YouTube still requires verification from Render. Browser-side resolution does not change the server’s IP.',403);
    }
    return{status:response.status,headers:{'Content-Type':response.headers.get('content-type')||'application/octet-stream','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'},data};
  }
  async diagnose(){
    if(this.diagnosticUntil>this.now())return this.diagnostic;
    if(this.diagnosticJob)return this.diagnosticJob;
    // Fixed, anonymous protocol access check. It never reports a metadata
    // response as verified playback and cannot be used to test arbitrary IDs.
    this.diagnosticJob=(async()=>{
      let stage='session';
      try{
        const session=await this.request({url:'https://www.youtube.com/sw.js_data',method:'GET'});
        const raw=session.data.toString();if(!raw.startsWith(")]}'"))throw fail('INVALID_SESSION_RESPONSE','YouTube did not return anonymous session metadata.',502);
        const device=JSON.parse(raw.slice(5))?.[0]?.[2]?.[0]?.[0];
        if(!Array.isArray(device))throw fail('INVALID_SESSION_RESPONSE','YouTube returned unfamiliar session metadata.',502);
        stage='player';
        const context={client:{clientName:'MWEB',clientVersion:'2.20260205.04.01',hl:device[0]||'en',gl:device[1]||'US',visitorData:device[13],osName:device[17],osVersion:device[18]},user:{lockedSafetyMode:false}};
        const response=await this.request({url:'https://www.youtube.com/youtubei/v1/player?prettyPrint=false',method:'POST',headers:{'x-youtube-client-name':'2','x-youtube-client-version':context.client.clientVersion,'x-goog-visitor-id':device[13]},body:JSON.stringify({context,videoId:'dQw4w9WgXcQ',contentCheckOk:true,racyCheckOk:true})});
        const data=JSON.parse(response.data.toString()),status=data.playabilityStatus?.status;
        const count=(data.streamingData?.adaptiveFormats||[]).filter(f=>/^audio\//.test(f.mimeType||'')&&!f.width&&(f.url||f.signatureCipher)).length;
        this.diagnostic={ok:status==='OK',stage,playerStatus:status||'UNKNOWN',directAudioFormats:count,audioDeliveryVerified:false,recordingId:'dQw4w9WgXcQ',checkedAt:new Date(this.now()).toISOString()};
      }catch(error){this.diagnostic={ok:false,stage,code:error.code||'PROXY_CHECK_FAILED',error:error instanceof AudioError?error.message:'The anonymous YouTube access check failed.',audioDeliveryVerified:false,recordingId:'dQw4w9WgXcQ',checkedAt:new Date(this.now()).toISOString()};}
      this.diagnosticUntil=this.now()+600000;return this.diagnostic;
    })();
    try{return await this.diagnosticJob;}finally{this.diagnosticJob=null;}
  }
  register(input){
    const record=validateBrowserAudio(input,this.now()),key=randomBytes(24).toString('hex');
    for(const [id,value]of this.sources)if(value.expiresAt<=this.now())this.sources.delete(id);
    while(this.sources.size>=200)this.sources.delete(this.sources.keys().next().value);
    this.sources.set(key,record);
    const sig=createHmac('sha256',this.secret).update('browser-audio:'+key).digest('hex');
    return{engine:'audio',url:new URL('/browser-audio/'+key+'.'+sig,this.base).href,mimeType:record.mimeType,expiresAt:record.expiresAt};
  }
  async stream(req,res,token){
    if(!/^[a-f0-9]{48}\.[a-f0-9]{64}$/.test(token))throw fail('INVALID_AUDIO_TICKET','Invalid browser audio ticket.',401);
    const [key,sig]=token.split('.'),expected=createHmac('sha256',this.secret).update('browser-audio:'+key).digest('hex');
    if(!timingSafeEqual(Buffer.from(sig),Buffer.from(expected)))throw fail('INVALID_AUDIO_TICKET','Invalid browser audio ticket.',401);
    const record=this.sources.get(key);if(!record||record.expiresAt<=this.now())throw fail('AUDIO_SOURCE_EXPIRED','The browser audio source expired. Resolve this recording again.',410);
    const origin=req.headers.origin;if(origin&&origin!==this.origin)throw fail('ORIGIN_REJECTED','This audio origin is not allowed.',403);
    if(origin){res.setHeader('Access-Control-Allow-Origin',origin);res.setHeader('Vary','Origin');}
    res.setHeader('Access-Control-Allow-Methods','GET, HEAD, OPTIONS');res.setHeader('Access-Control-Allow-Headers','Range');res.setHeader('Access-Control-Expose-Headers','Content-Length, Content-Range, Accept-Ranges');res.setHeader('Cross-Origin-Resource-Policy','cross-origin');res.setHeader('Cache-Control','private, no-store');
    if(req.method==='OPTIONS'){res.writeHead(204);res.end();return;}
    const range=req.headers.range;if(range&&(range.length>80||!/^bytes=(?:\d+-\d*|-\d+)$/.test(range)))throw fail('INVALID_AUDIO_RANGE','A single byte range is required.',416);
    if(this.active>=12)throw fail('AUDIO_BUSY','Audio delivery is busy. Try again shortly.',503);
    const abort=new AbortController(),disconnect=()=>abort.abort();res.once('close',disconnect);this.active++;
    const audioFetch=async(...args)=>{const response=await this.fetch(...args);if([200,206].includes(response.status)&&response.headers.get('content-type')?.split(';')[0]!==record.mimeType){await response.body?.cancel();throw fail('NON_AUDIO_RESPONSE','The provider returned an unexpected audio content type.',502);}return response;};
    try{await relayAudioChunks({record,range,method:req.method,res,ticket:{id:record.id,formatId:record.formatId},fetchImpl:audioFetch,signal:abort.signal,extractor:{resolve:async()=>{throw fail('AUDIO_SOURCE_EXPIRED','The source was rejected. Resolve it again in the browser.',410);},pauseFor:error=>this.block(error.code,error.message,error.status)}});}
    finally{this.active--;res.off('close',disconnect);abort.abort();}
  }
}
