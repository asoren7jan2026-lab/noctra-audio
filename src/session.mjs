import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AudioError} from './errors.mjs';

const invalid=()=>new AudioError('YOUTUBE_SESSION_INVALID','The configured YouTube session is invalid or expired. Supply a YouTube-only Netscape cookie file in the private YTDLP_COOKIES setting.',503,false,'authentication');
export function validateYoutubeSession(input,now=Date.now()){
  if(typeof input!=='string'||Buffer.byteLength(input)>65536||input.includes('\0'))throw invalid();
  const lines=input.replace(/\r\n/g,'\n').split('\n');
  if(!/^# (?:Netscape )?HTTP Cookie File\s*$/.test(lines[0]))throw invalid();
  let session=false,records=0;
  for(const line of lines.slice(1)){
    if(!line.trim()||(line.startsWith('#')&&!line.startsWith('#HttpOnly_')))continue;
    const fields=(line.startsWith('#HttpOnly_')?line.slice(10):line).split('\t');
    if(fields.length!==7)throw invalid();
    const [domain,subdomains,path,secure,expiry,name,value]=fields;
    const host=domain.replace(/^\./,'').toLowerCase();
    if(!(host==='youtube.com'||host.endsWith('.youtube.com'))||!['TRUE','FALSE'].includes(subdomains)||!['TRUE','FALSE'].includes(secure)||!path.startsWith('/')||!/^[0-9]{1,12}$/.test(expiry)||!name||!value||/[\x00-\x20\x7f]/.test(name+value))throw invalid();
    if(Number(expiry)>0&&Number(expiry)*1000<=now)continue;
    records++;
    if(/^(?:SAPISID|__Secure-[13]PAPISID)$/.test(name))session=true;
  }
  if(!records||!session)throw invalid();
  return lines.join('\n')+'\n';
}
export async function prepareYoutubeSession(input){
  if(!input)return null;
  const cookies=validateYoutubeSession(input);
  const directory=await mkdtemp(join(tmpdir(),'noctra-youtube-'));
  const path=join(directory,'cookies.txt');
  try{await writeFile(path,cookies,{mode:0o600,flag:'wx'});}
  catch(error){await rm(directory,{recursive:true,force:true});throw new AudioError('YOUTUBE_SESSION_SETUP_FAILED','The server could not prepare its private YouTube session.',503,false,'authentication');}
  return{path,cleanup:()=>rm(directory,{recursive:true,force:true})};
}
