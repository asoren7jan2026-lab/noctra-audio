import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {AudioError} from './errors.mjs';
import {mediaURL} from './extractor.mjs';

// Bounded requests avoid a long, stalled CDN transfer. No video or transcoding.
export async function relayAudioChunks({record,range,method,res,extractor,ticket,fetchImpl,signal}) {
  const total=Number(new URL(record.sourceUrl).searchParams.get('clen'));
  if(!Number.isSafeInteger(total)||total<=0)return false;
  let start=0,end=total-1;
  if(range){
    const match=range.match(/^bytes=(\d*)-(\d*)$/);
    if(!match)return false;
    if(!match[1])start=Math.max(0,total-Number(match[2]));
    else{start=Number(match[1]);if(match[2])end=Math.min(end,Number(match[2]));}
    if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start>=total||end<start){
      res.writeHead(416,{'Content-Range':'bytes */'+total});res.end();return true;
    }
  }
  const size=256*1024;
  let refreshJob=null,refreshUsed=false;
  const refresh=()=>{
    if(!refreshJob){
      refreshUsed=true;
      refreshJob=extractor.resolve(ticket.id,{formatId:ticket.formatId,force:true}).then(value=>{
        if(Number(new URL(value.sourceUrl).searchParams.get('clen'))!==total)throw new AudioError('SOURCE_CHANGED','The audio representation changed. Resolve this recording again.',502,true,'audio_delivery');
        record=value;
      });
    }
    return refreshJob;
  };
  const readPart=async(first,last)=>{
    for(let attempt=0;attempt<2;attempt++){
      let target=record.sourceUrl,response;
      const partSignal=AbortSignal.any([signal,AbortSignal.timeout(45000)]);
      for(let redirect=0;redirect<3;redirect++){
        mediaURL(target);
        response=await fetchImpl(target,{headers:{...record.headers,Range:'bytes='+first+'-'+last,'Accept-Encoding':'identity'},redirect:'manual',signal:partSignal});
        if([301,302,303,307,308].includes(response.status)){
          const location=response.headers.get('location');await response.body?.cancel();
          if(!location)throw new AudioError('INVALID_AUDIO_REDIRECT','The audio provider returned an invalid redirect.',502,false,'audio_delivery');
          target=mediaURL(new URL(location,target).href).href;response=undefined;continue;
        }
        break;
      }
      if(!response)throw new AudioError('AUDIO_REDIRECT_LIMIT','The audio provider returned too many redirects.',502,false,'audio_delivery');
      if(attempt===0&&[403,410].includes(response.status)&&(!refreshUsed||refreshJob)){
        await response.body?.cancel();await refresh();continue;
      }
      if(response.status===429){await response.body?.cancel();throw new AudioError('UPSTREAM_RATE_LIMIT','The audio provider is rate-limiting delivery. Retry later.',429,true,'audio_delivery');}
      if(response.status!==206){await response.body?.cancel();throw new AudioError('AUDIO_RANGE_REJECTED','The audio provider rejected the byte-range request (HTTP '+response.status+').',502,false,'audio_delivery');}
      if(response.headers.get('content-range')!=='bytes '+first+'-'+last+'/'+total){
        await response.body?.cancel();throw new AudioError('INCOMPLETE_AUDIO','The provider returned an incomplete audio range or changed its representation.',502,true,'audio_delivery');
      }
      const parts=[];let bytes=0,wanted=last-first+1;
      for await(const part of response.body){bytes+=part.length;if(bytes>wanted)throw new AudioError('INCOMPLETE_AUDIO','The provider returned oversized audio data.',502,false,'audio_delivery');parts.push(Buffer.from(part));}
      if(bytes!==wanted)throw new AudioError('INCOMPLETE_AUDIO','The provider returned an incomplete audio range.',502,true,'audio_delivery');
      return Buffer.concat(parts);
    }
    throw new AudioError('AUDIO_ACCESS_DENIED','The provider rejected this audio source after refresh.',502,false,'audio_delivery');
  };
  const setHeaders=()=>{
    res.statusCode=range?206:200;res.setHeader('Content-Type',record.mimeType);
    res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Accept-Ranges','bytes');
    res.setHeader('Content-Length',String(end-start+1));
    if(range)res.setHeader('Content-Range','bytes '+start+'-'+end+'/'+total);
  };
  if(method==='HEAD'){setHeaders();res.end();return true;}
  let cursor=start;
  const pending=[];
  const enqueue=()=>{
    if(cursor>end)return;
    const first=cursor,last=Math.min(end,first+size-1);cursor=last+1;
    // Rejections are held until consumed so a prefetched failure is never unhandled.
    pending.push(readPart(first,last).then(data=>({data}),error=>({error})));
  };
  enqueue();enqueue();
  const first=await pending.shift();
  if(first.error)throw first.error;
  setHeaders();
  async function* output(){
    enqueue();yield first.data;
    while(pending.length){const part=await pending.shift();if(part.error)throw part.error;enqueue();yield part.data;}
  }
  await pipeline(Readable.from(output()),res);
  return true;
}
