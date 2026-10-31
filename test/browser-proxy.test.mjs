import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {BrowserYoutubeProxy,validateProxyRequest,validateBrowserAudio} from '../src/browser-proxy.mjs';
import {createAudioServer} from '../src/server.mjs';

const id='AbCdEfGhI_1',secret='s'.repeat(40),key='k'.repeat(40),origin='https://noctra.example';
const audioUrl=(mime='audio/mp4')=>'https://rr1.googlevideo.com/videoplayback?'+new URLSearchParams({mime,expire:String(Math.floor(Date.now()/1000)+3600),clen:'2048',itag:'140'});
const player={url:'https://www.youtube.com/youtubei/v1/player',method:'POST',body:JSON.stringify({videoId:id,context:{}})};

test('proxy rejects arbitrary hosts, redirects-as-targets, video UI, unsupported methods and oversized bodies',()=>{
 for(const url of ['http://www.youtube.com/','https://www.youtube.com.evil.test/','https://127.0.0.1/','https://user:pass@www.youtube.com/','https://www.youtube.com:444/','https://www.youtube.com/redirect?q=https://evil.test','https://www.youtube.com/embed/'+id,'https://www.youtube.com/iframe_api'])assert.throws(()=>validateProxyRequest({url}),e=>e.status===403);
 assert.throws(()=>validateProxyRequest({...player,method:'PUT'}));
 assert.throws(()=>validateProxyRequest({...player,body:'x'.repeat(131073)}),e=>e.status===413);
 const p=validateProxyRequest({...player,headers:{Cookie:'session=secret',Authorization:'secret',Host:'evil.test','X-Forwarded-For':'local','X-Goog-Visitor-Id':'visitor'}});
 assert.equal(p.body,player.body);assert.equal(p.headers['x-goog-visitor-id'],'visitor');assert.equal(p.headers.Cookie,undefined);assert.equal(p.headers.Authorization,undefined);assert.equal(p.headers.Host,undefined);
});

test('proxy preserves protocol bytes, strips sensitive response headers, refuses redirects, and bounds response size',async()=>{
 let seen;const p=new BrowserYoutubeProxy({fetchImpl:async(url,opts)=>{seen=opts;return new Response(')]}\'\n[1,2]',{headers:{'Content-Type':'application/json','Set-Cookie':'secret'}});}});
 const r=await p.request({...player});assert.equal(r.data.toString(),")]}'\n[1,2]");assert.equal(seen.body,player.body);assert.equal(r.headers['Set-Cookie'],undefined);assert.equal(seen.redirect,'manual');
 p.fetch=async()=>new Response(null,{status:302,headers:{Location:'http://127.0.0.1'}});
 await assert.rejects(p.request(player),e=>e.code==='PROXY_REDIRECT_REJECTED');
 p.fetch=async()=>new Response(new Uint8Array(6*1024*1024+1));
 await assert.rejects(p.request(player),e=>e.code==='PROXY_RESPONSE_TOO_LARGE');
});

test('LOGIN_REQUIRED and 429 stop further upstream requests until cooldown expires',async()=>{
 let now=1000,calls=0;
 const p=new BrowserYoutubeProxy({now:()=>now,fetchImpl:async()=>{calls++;return Response.json({playabilityStatus:{status:'LOGIN_REQUIRED',reason:'Sign in'}});}});
 await assert.rejects(p.request(player),e=>e.code==='PROVIDER_VERIFICATION_REQUIRED');
 await assert.rejects(p.request(player),e=>e.code==='PROVIDER_VERIFICATION_REQUIRED');assert.equal(calls,1);
 now+=600001;p.fetch=async()=>new Response(null,{status:429});
 await assert.rejects(p.request(player),e=>e.code==='UPSTREAM_RATE_LIMIT');
 assert.equal(p.requests,0);
});

test('audio source validation never accepts video, arbitrary URLs, or expired sources',()=>{
 assert.equal(validateBrowserAudio({videoId:id,url:audioUrl(),mimeType:'audio/mp4'}).mimeType,'audio/mp4');
 for(const url of [audioUrl('video/mp4'),audioUrl().replace('rr1.googlevideo.com','rr1.googlevideo.com.evil.test'),audioUrl().replace('/videoplayback','/anything')])assert.throws(()=>validateBrowserAudio({videoId:id,url,mimeType:'audio/mp4'}));
 assert.throws(()=>validateBrowserAudio({videoId:id,url:audioUrl(),mimeType:'audio/mp4'},Date.now()+7200000));
});

test('authenticated registration and signed media relay support exact bytes, seeking, expiry and MIME enforcement without yt-dlp',async t=>{
 let type='audio/mp4',calls=0;
 const media=Buffer.alloc(2048,67);
 const server=createAudioServer({apiKey:key,signingKey:secret,publicBaseURL:'http://127.0.0.1',allowedOrigin:origin,extractor:{resolve(){throw new Error('yt-dlp must not run');}},fetchImpl:async(url,opts)=>{
  calls++;const [,first,last]=opts.headers.Range.match(/bytes=(\d+)-(\d+)/);const start=Number(first),end=Number(last);
  return new Response(media.subarray(start,end+1),{status:206,headers:{'Content-Type':type,'Content-Range':`bytes ${start}-${end}/2048`}});
 }});
 server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>{server.closeAllConnections();server.close();});
 const base='http://127.0.0.1:'+server.address().port;
 const input=JSON.stringify({videoId:id,url:audioUrl(),mimeType:'audio/mp4'});
 assert.equal((await fetch(base+'/internal/browser-audio',{method:'POST',body:input})).status,401);
 const registration=await fetch(base+'/internal/browser-audio',{method:'POST',headers:{Authorization:'Bearer '+key},body:input});assert.equal(registration.status,200);
 const data=await registration.json(),url=base+new URL(data.url).pathname;
 let response=await fetch(url,{headers:{Origin:origin}});assert.equal(response.status,200);assert.equal(response.headers.get('content-type'),'audio/mp4');assert.deepEqual(Buffer.from(await response.arrayBuffer()),media);
 response=await fetch(url,{headers:{Origin:origin,Range:'bytes=10-19'}});assert.equal(response.status,206);assert.equal(response.headers.get('content-range'),'bytes 10-19/2048');assert.equal((await response.arrayBuffer()).byteLength,10);
 assert.equal((await fetch(url,{headers:{Origin:'https://evil.test'}})).status,403);
 assert.equal((await fetch(url+'x')).status,401);
 type='video/mp4';response=await fetch(url);assert.equal(response.status,502);assert.equal((await response.json()).code,'NON_AUDIO_RESPONSE');
 assert.ok(calls>=3);
});

test('fixed anonymous diagnostic is cached and never claims audio delivery',async()=>{
 let calls=0;const device=[];device[0]='en';device[1]='US';device[13]='visitor';
 const p=new BrowserYoutubeProxy({fetchImpl:async(url)=>{calls++;if(String(url).endsWith('/sw.js_data'))return new Response(")]}'\n"+JSON.stringify([[null,null,[[device],'key']]]));return Response.json({playabilityStatus:{status:'OK'},streamingData:{adaptiveFormats:[{mimeType:'audio/mp4',url:audioUrl()}]}});}});
 const first=await p.diagnose();assert.equal(first.ok,true);assert.equal(first.audioDeliveryVerified,false);assert.equal(first.directAudioFormats,1);assert.equal(first.recordingId,'dQw4w9WgXcQ');
 await p.diagnose();assert.equal(calls,2);
});
