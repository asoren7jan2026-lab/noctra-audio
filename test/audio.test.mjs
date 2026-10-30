import {test} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {Extractor, normalizeAudio, mediaURL, AUDIO_FORMAT} from '../src/extractor.mjs';
import {createAudioServer, signTicket, verifyTicket} from '../src/server.mjs';
const id='AbCdEfGhI_1',apiKey='api-example-secret-abcdefghijklmnopqrstuvwxyz',signingKey='sign-example-secret-abcdefghijklmnopqrstuvwxyz';
const info={id,title:'Song',artist:'Artist',duration:200,vcodec:'none',acodec:'mp4a.40.2',ext:'m4a',format_id:'140',abr:129,
  url:'https://rr1.googlevideo.com/videoplayback?expire='+Math.floor((Date.now()+3600000)/1000),http_headers:{'User-Agent':'test-agent',Referer:'https://music.youtube.com/'}};
test('rejects combined formats and arbitrary media URLs',()=>{
  assert.throws(()=>normalizeAudio({...info,vcodec:'avc1'},id));
  assert.throws(()=>normalizeAudio({...info,acodec:'none'},id));
  assert.throws(()=>normalizeAudio({...info,is_live:true},id));
  assert.throws(()=>mediaURL('https://googlevideo.com.attacker.invalid/audio'));
  assert.throws(()=>mediaURL('https://localhost/audio'));assert.throws(()=>mediaURL('http://rr1.googlevideo.com/audio'));
  assert.throws(()=>mediaURL('https://user:password@rr1.googlevideo.com/audio'));
  assert.throws(()=>normalizeAudio({...info,url:'https://rr1.googlevideo.com/media?expire=1'},id));
  assert.equal(normalizeAudio(info,id).mimeType,'audio/mp4');
  assert.ok(!AUDIO_FORMAT.includes('/best/'));
});
test('pins identity, de-duplicates concurrent extraction and never invokes a shell',async()=>{
  let calls=0;
  const extractor=new Extractor({run:async(binary,args,options)=>{calls++;assert.equal(options.shell,false);assert.equal(args.at(-1),'https://music.youtube.com/watch?v='+id);assert.ok(args.includes(AUDIO_FORMAT));return{stdout:JSON.stringify(info)};}});
  const results=await Promise.all([extractor.resolve(id),extractor.resolve(id),extractor.resolve(id)]);
  assert.equal(calls,1);assert.equal(results[0].id,id);await extractor.resolve(id);assert.equal(calls,1);
  await assert.rejects(()=>extractor.resolve('bad;command'));assert.equal(calls,1);
});
test('signed tickets expire and reject tampering',()=>{
  const ticket=signTicket({id,formatId:'140',exp:Date.now()+60000},signingKey);
  assert.equal(verifyTicket(ticket,signingKey).id,id);
  assert.throws(()=>verifyTicket(ticket+'x',signingKey));
  assert.throws(()=>verifyTicket(ticket,signingKey,Date.now()+120000));
});
test('gateway authentication, audio URL contract, byte seeking, refresh and origin boundaries',async()=>{
  let mediaRequests=0,refreshes=0;
  const extractor={search:async()=>[{id,title:'Song'}],resolve:async(_id,options)=>{if(options?.force)refreshes++;return normalizeAudio(info,id);}};
  const server=createAudioServer({apiKey,signingKey,publicBaseURL:'https://audio.example.test',allowedOrigin:'https://noctra.example.test',extractor,
    fetchImpl:async(url,options)=>{mediaRequests++;assert.equal(options.headers.Range,'bytes=2-4');if(mediaRequests===1)return new Response(null,{status:403});return new Response(new Uint8Array([2,3,4]),{status:206,headers:{'Content-Range':'bytes 2-4/100','Content-Length':'3','Accept-Ranges':'bytes'}});}});
  server.listen(0,'127.0.0.1');await once(server,'listening');const root='http://127.0.0.1:'+server.address().port;
  try{
    let response=await fetch(root+'/internal/resolve',{method:'POST',body:JSON.stringify({videoId:id})});assert.equal(response.status,401);
    response=await fetch(root+'/internal/resolve',{method:'POST',headers:{Authorization:'Bearer '+apiKey},body:JSON.stringify({videoId:id})});
    assert.equal(response.status,200);const record=await response.json();assert.equal(record.artist,'Artist');assert.equal(record.mimeType,'audio/mp4');assert.ok(!('sourceUrl'in record));
    const path=new URL(record.audioUrl).pathname;
    response=await fetch(root+path,{headers:{Range:'bytes=2-4',Origin:'https://noctra.example.test'}});assert.equal(response.status,206);assert.equal(response.headers.get('content-range'),'bytes 2-4/100');assert.equal(response.headers.get('content-type'),'audio/mp4');assert.deepEqual([...new Uint8Array(await response.arrayBuffer())],[2,3,4]);assert.equal(refreshes,1);
    response=await fetch(root+path,{headers:{Origin:'https://untrusted.invalid'}});assert.equal(response.status,403);
    response=await fetch(root+path,{headers:{Range:'bytes=0-1,4-5'}});assert.equal(response.status,416);
    response=await fetch(root+'/audio/bad-ticket');assert.equal(response.status,401);
  }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
test('rejects truncated upstream media instead of reporting playable audio',async()=>{
 const extractor={resolve:async()=>normalizeAudio({...info,url:info.url+'&clen=1000000'},id)};
 const server=createAudioServer({apiKey,signingKey,publicBaseURL:'https://audio.example.test',allowedOrigin:'https://noctra.example.test',extractor,
  fetchImpl:async()=>new Response(new Uint8Array(64),{status:206,headers:{'Content-Range':'bytes 0-63/195','Content-Length':'64'}})});
 server.listen(0,'127.0.0.1');await once(server,'listening');const root='http://127.0.0.1:'+server.address().port;
 try{const ticket=signTicket({id,formatId:'140',exp:Date.now()+60000},signingKey);const response=await fetch(root+'/audio/'+ticket);assert.equal(response.status,502);assert.match((await response.json()).error,/incomplete audio/);}
 finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
