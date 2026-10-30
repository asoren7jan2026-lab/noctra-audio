import {test} from 'node:test';
import assert from 'node:assert/strict';
import {access,readFile,stat} from 'node:fs/promises';
import {validateYoutubeSession,prepareYoutubeSession} from '../src/session.mjs';
import {Extractor,normalizeAudio} from '../src/extractor.mjs';
import {runProcess} from '../src/process.mjs';
const cookie='# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t0\tSAPISID\tfixture-session-not-real\n';
const id='AbCdEfGhI_1';
const publicInfo={id,title:'Song',artist:'Artist',availability:'public',age_limit:0,duration:180,vcodec:'none',acodec:'mp4a.40.2',ext:'m4a',format_id:'140',url:'https://rr1.googlevideo.com/videoplayback?expire='+Math.floor((Date.now()+3600000)/1000)};

test('session validation rejects other sites, broken files and expired login data',()=>{
 assert.equal(validateYoutubeSession(cookie).includes('fixture-session-not-real'),true);
 for(const value of ['not cookies',cookie.replace('.youtube.com','.google.com'),cookie.replace('.youtube.com','.youtube.com.attacker.test'),cookie.replace('\t0\t','\t1\t'),cookie.replace('\tSAPISID\t','\tPREF\t'),cookie+'x'.repeat(65537)])assert.throws(()=>validateYoutubeSession(value),e=>e.code==='YOUTUBE_SESSION_INVALID'&&!e.message.includes('fixture-session-not-real'));
});

test('private session files have restricted permissions and are deleted after the process',async()=>{
 let path,seen=false;
 const extractor=new Extractor({cookies:cookie,run:async(_,args)=>{
   path=args[args.indexOf('--cookies')+1];assert.ok(path);
   assert.equal((await stat(path)).mode&0o777,0o600);
   assert.equal((await stat(new URL('.',new URL('file://'+path)).pathname)).mode&0o777,0o700);
   assert.ok((await readFile(path,'utf8')).includes('fixture-session-not-real'));seen=true;
   return{stdout:JSON.stringify(publicInfo)};
 }});
 assert.equal((await extractor.resolve(id)).id,id);assert.equal(seen,true);
 await assert.rejects(()=>access(path),{code:'ENOENT'});
 assert.deepEqual(extractor.authentication(),{configured:true,publicRecordingsOnly:true});
 assert.ok(!JSON.stringify(extractor).includes('fixture-session-not-real'));
});

test('failed extraction also cleans up session data and never authenticates catalog search',async()=>{
 let path;
 const extractor=new Extractor({cookies:cookie,run:async(_,args)=>{
  if(args.includes('--flat-playlist')){assert.equal(args.includes('--cookies'),false);return{stdout:'{"entries":[]}'};}
  path=args[args.indexOf('--cookies')+1];throw new Error('fixture transport failure');
 }});
 await assert.rejects(()=>extractor.resolve(id),e=>e.code==='EXTRACTION_FAILED');
 await assert.rejects(()=>access(path),{code:'ENOENT'});
 assert.deepEqual(await extractor.search('public music'),[]);
});

test('authenticated resolution cannot expose private, subscriber, age restricted or unknown availability',()=>{
 assert.equal(normalizeAudio(publicInfo,id,Date.now(),{authenticated:true}).id,id);
 for(const availability of ['private','subscriber_only','premium_only','needs_auth',undefined])assert.throws(()=>normalizeAudio({...publicInfo,availability},id,Date.now(),{authenticated:true}),e=>e.code==='NONPUBLIC_RECORDING');
 assert.throws(()=>normalizeAudio({...publicInfo,age_limit:18},id,Date.now(),{authenticated:true}),e=>e.code==='NONPUBLIC_RECORDING');
});

test('raw session secrets are not inherited by extractor subprocesses',async()=>{
 const prior=process.env.YTDLP_COOKIES;process.env.YTDLP_COOKIES=cookie;
 try{const result=await runProcess(process.execPath,['-e','process.stdout.write(String(process.env.YTDLP_COOKIES))'],{timeout:3000});assert.equal(result.stdout,'undefined');}
 finally{if(prior===undefined)delete process.env.YTDLP_COOKIES;else process.env.YTDLP_COOKIES=prior;}
 assert.equal(await prepareYoutubeSession(''),null);
});
