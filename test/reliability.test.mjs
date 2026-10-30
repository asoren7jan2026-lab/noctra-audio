import {test} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {Extractor,normalizeAudio} from '../src/extractor.mjs';
import {AudioError,extractionError,diagnosticLine} from '../src/errors.mjs';
import {runProcess} from '../src/process.mjs';
import {createAudioServer} from '../src/server.mjs';
import {probeAudioGateway} from '../src/probe.mjs';
const id='AbCdEfGhI_1',apiKey='reliability-api-abcdefghijklmnopqrstuvwxyz',signingKey='reliability-sign-abcdefghijklmnopqrstuvwxyz';
const info={id,title:'Song',artist:'Artist',duration:210,vcodec:'none',acodec:'mp4a.40.2',ext:'m4a',format_id:'140',url:'https://rr1.googlevideo.com/videoplayback?expire='+Math.floor((Date.now()+3600000)/1000)};

test('classifies actual upstream failures without exposing upstream URLs',()=>{
 const cases=[
  [{code:'ENOENT'},'EXTRACTOR_NOT_INSTALLED',503,false],
  [{killed:true},'EXTRACTION_TIMEOUT',504,true],
  [{stderr:"ERROR: Sign in to confirm you're not a bot"},'PROVIDER_VERIFICATION_REQUIRED',403,false],
  [{stderr:'WARNING: HTTP Error 429: Too Many Requests\nERROR: [youtube] n0GXk_T2zs8: Sign in to confirm you’re not a bot. Use cookies for authentication.'},'PROVIDER_VERIFICATION_REQUIRED',403,false],
  [{stderr:'ERROR: HTTP Error 429: Too Many Requests'},'UPSTREAM_RATE_LIMIT',429,true],
  [{stderr:'ERROR: The uploader has not made this video available in your country'},'REGION_RESTRICTED',451,false],
  [{stderr:'ERROR: Requested format is not available'},'AUDIO_FORMAT_UNAVAILABLE',422,false],
  [{stderr:'ERROR: Unable to download webpage: connection reset'},'UPSTREAM_NETWORK_ERROR',502,true],
 ];
 for(const [raw,code,status,retryable] of cases){const result=extractionError(raw);assert.equal(result.code,code);assert.equal(result.status,status);assert.equal(result.retryable,retryable);}
 const line=diagnosticLine('WARNING: earlier\nERROR: source https://rr1.googlevideo.com/playback?sig=secret token=private');
 assert.ok(!line.includes('sig=secret'));assert.ok(!line.includes('token=private'));assert.ok(!line.includes('https://'));
});

test('provider cooldown spans recordings, forced refresh and search without more subprocesses',async()=>{
 let clock=Date.now(),calls=0;
 const extractor=new Extractor({now:()=>clock,run:async()=>{calls++;if(calls===2)throw Object.assign(new Error('limited'),{stderr:'ERROR: HTTP Error 429: Too Many Requests'});return{stdout:JSON.stringify(info)};}});
 await extractor.resolve(id);
 clock+=180000;
 await extractor.resolve(id);assert.equal(calls,1,'valid URLs survive longer than the old two-minute cache');
 await assert.rejects(()=>extractor.resolve('AbCdEfGhI_2'),e=>e.code==='UPSTREAM_RATE_LIMIT'&&e.retryAt===clock+600000);
 await assert.rejects(()=>extractor.resolve('AbCdEfGhI_3'),e=>e.code==='UPSTREAM_RATE_LIMIT');
 await assert.rejects(()=>extractor.resolve(id,{force:true}),e=>e.code==='UPSTREAM_RATE_LIMIT');
 await assert.rejects(()=>extractor.search('song'),e=>e.code==='UPSTREAM_RATE_LIMIT');
 assert.equal((await extractor.resolve(id)).id,id,'valid cached audio remains available');
 assert.equal(calls,2);assert.equal(extractor.availability().retryAfterSeconds,600);
 clock+=600001;assert.equal(extractor.availability().available,true);
 await extractor.resolve(id);assert.equal(calls,3);
});

test('one free-tier process is allowed; a failed extraction does not poison later requests',async()=>{
 let release;
 const pending=new Promise(resolve=>{release=resolve});
 let calls=0;
 const extractor=new Extractor({run:async()=>{calls++;if(calls===1){await pending;throw Object.assign(new Error('failed'),{killed:true});}return{stdout:JSON.stringify(info)};}});
 const first=extractor.resolve(id);const duplicate=extractor.resolve(id);
 const rejectedFirst=assert.rejects(first,e=>e.code==='EXTRACTION_TIMEOUT');
 const rejectedDuplicate=assert.rejects(duplicate,e=>e.code==='EXTRACTION_TIMEOUT');
 await assert.rejects(()=>extractor.resolve('AbCdEfGhI_2'),e=>e.code==='EXTRACTOR_BUSY'&&e.status===503);
 release();await Promise.all([rejectedFirst,rejectedDuplicate]);assert.equal(calls,1);
 assert.equal((await extractor.resolve(id)).id,id);assert.equal(calls,2);
});

test('real subprocess deadlines and output limits stop the child process',async()=>{
 const started=Date.now();
 await assert.rejects(()=>runProcess(process.execPath,['-e','process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'],{timeout:150}),e=>e.code==='ETIMEDOUT'&&e.killed);
 assert.ok(Date.now()-started<3000);
 await assert.rejects(()=>runProcess(process.execPath,['-e','process.stdout.write("x".repeat(2000000))'],{timeout:3000,maxBuffer:512}),e=>e.code==='MAXBUFFER');
});

async function serve(options,fn){
 const server=createAudioServer({apiKey,signingKey,publicBaseURL:'https://audio.example.test',allowedOrigin:'https://noctra.example.test',testRecordingId:id,...options});
 server.listen(0,'127.0.0.1');await once(server,'listening');
 try{await fn('http://127.0.0.1:'+server.address().port);}
 finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
}
test('verification errors expose a cooldown and process health does not claim provider readiness',async()=>{
 let calls=0;
 const extractor=new Extractor({run:async()=>{calls++;throw Object.assign(new Error('verification'),{stderr:'WARNING: HTTP Error 429\nERROR: Sign in to confirm you’re not a bot.'});}});
 await serve({extractor},async root=>{
  const resolve=videoId=>fetch(root+'/internal/resolve',{method:'POST',headers:{Authorization:'Bearer '+apiKey},body:JSON.stringify({videoId,force:true})});
  let r=await resolve(id),failure=await r.json();assert.equal(r.status,403);assert.equal(failure.code,'PROVIDER_VERIFICATION_REQUIRED');assert.equal(failure.retryable,false);assert.ok(Number(r.headers.get('retry-after'))>=599);
  r=await resolve('AbCdEfGhI_2');assert.equal(r.status,403);assert.equal(calls,1);
  const health=await(await fetch(root+'/health')).json();assert.equal(health.ok,true);assert.equal(health.provider.available,false);assert.equal(health.provider.code,'PROVIDER_VERIFICATION_REQUIRED');assert.ok(!JSON.stringify(health).includes(apiKey));
 });
});
test('public diagnostic verifies bounded CDN ranges, complete audio and seeking once',async()=>{
 const size=786509,ranges=[];let resolves=0,done;const completion=new Promise(resolve=>{done=resolve});
 await serve({
  extractor:{resolve:async(_,options)=>{if(!options?.formatId)resolves++;return normalizeAudio({...info,url:info.url+'&clen='+size},id);}},
  fetchImpl:async(_,options)=>{const match=options.headers.Range.match(/^bytes=(\d+)-(\d+)$/);assert.ok(match);const start=Number(match[1]),end=Number(match[2]),length=end-start+1;ranges.push([start,end]);assert.ok(length<=262144);return new Response(new Uint8Array(length),{status:206,headers:{'Content-Type':'audio/mp4','Content-Length':String(length),'Content-Range':'bytes '+start+'-'+end+'/'+size,'Accept-Ranges':'bytes'}});},
  runProbe:async options=>{try{return await probeAudioGateway(options);}finally{done();}}
 },async root=>{
  let r=await fetch(root+'/test');assert.equal(r.status,202);
  await completion;
  r=await fetch(root+'/test');const result=await r.json();assert.equal(r.status,200);assert.equal(result.ok,true);assert.equal(result.bytes,size);assert.equal(result.checks.audioTransfer,'passed');assert.equal(result.checks.seeking,'passed');assert.ok(result.metadata.audioUrl.startsWith('https://audio.example.test/audio/'));
  assert.deepEqual(ranges,[[0,262143],[262144,524287],[524288,786431],[786432,786508],[1024,2047]]);
  await fetch(root+'/test');assert.equal(resolves,1);
  r=await fetch(root+'/test?videoId=another');assert.equal(r.status,400);assert.equal(resolves,1);
  r=await fetch(root+'/internal/test',{method:'POST',body:'{}'});assert.equal(r.status,401);
 });
});

test('diagnostic identifies extraction failure and preserves its actionable API code',async()=>{
 let done;const completion=new Promise(resolve=>{done=resolve});
 await serve({extractor:{resolve:async()=>{throw new AudioError('PROVIDER_VERIFICATION_REQUIRED','YouTube requires verification for this server request.',403);}},
  runProbe:async options=>{try{return await probeAudioGateway(options);}finally{done();}}
 },async root=>{
  let r=await fetch(root+'/internal/resolve',{method:'POST',headers:{Authorization:'Bearer '+apiKey},body:JSON.stringify({videoId:id})});
  const failure=await r.json();assert.equal(r.status,403);assert.equal(failure.code,'PROVIDER_VERIFICATION_REQUIRED');assert.equal(failure.retryable,false);assert.equal(failure.stage,'extraction');
  await fetch(root+'/test');await completion;
  r=await fetch(root+'/test');const result=await r.json();assert.equal(r.status,502);assert.equal(result.stage,'extraction');assert.equal(result.error.code,'PROVIDER_VERIFICATION_REQUIRED');assert.equal(result.checks.audioTransfer,'not_run');assert.ok(!JSON.stringify(result).includes(apiKey));
 });
});
