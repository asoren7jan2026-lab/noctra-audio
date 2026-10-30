import {AudioError,publicError} from './errors.mjs';

// Check extraction, complete audio delivery and byte seeking as separate stages.
export async function probeAudioGateway({port,apiKey,recordingId,allowedOrigin,onProgress=()=>{},resolveTimeoutMs=165000,transferTimeoutMs=120000}) {
  const base='http://127.0.0.1:'+port,started=Date.now();
  const checks={extraction:'pending',audioTransfer:'not_run',seeking:'not_run'};
  let stage='extraction',metadata,bytes=0;
  const progress=()=>onProgress({status:'running',stage,recordingId,startedAt:new Date(started).toISOString(),elapsedMs:Date.now()-started,checks:{...checks}});
  try {
    progress();
    const resolved=await fetch(base+'/internal/resolve',{method:'POST',headers:{Authorization:'Bearer '+apiKey,'Content-Type':'application/json','X-Noctra-User':'deployment-probe'},body:JSON.stringify({videoId:recordingId}),signal:AbortSignal.timeout(resolveTimeoutMs)});
    let data;try{data=await resolved.json();}catch{throw new AudioError('INVALID_SERVICE_RESPONSE','The resolver returned invalid JSON.',502,true,stage);}
    if(!resolved.ok)throw new AudioError(data.code||'EXTRACTION_FAILED',data.error||'Audio extraction failed.',resolved.status,!!data.retryable,data.stage||stage);
    if(data.id!==recordingId||typeof data.audioUrl!=='string'||!data.mimeType?.startsWith('audio/'))throw new AudioError('INVALID_AUDIO_RESPONSE','The resolver did not return an audio-only stream.',502,false,stage);
    metadata={id:data.id,title:data.title,artist:data.artist,duration:data.duration,mimeType:data.mimeType,expiresAt:data.expiresAt,audioUrl:data.audioUrl};
    checks.extraction='passed';stage='audio_headers';checks.audioTransfer='pending';progress();
    const media=base+new URL(data.audioUrl).pathname;
    const full=await fetch(media,{headers:{Origin:allowedOrigin},signal:AbortSignal.timeout(transferTimeoutMs)});
    if(![200,206].includes(full.status)||!full.headers.get('content-type')?.startsWith('audio/')){
      let failure;try{failure=await full.json();}catch{}
      throw new AudioError(failure?.code||'AUDIO_TRANSFER_FAILED',failure?.error||'The extracted stream did not deliver audio.',full.status>=400?full.status:502,!!failure?.retryable,stage);
    }
    const expected=Number(full.headers.get('content-length')),contentRange=full.headers.get('content-range');
    stage='audio_transfer';progress();
    for await(const chunk of full.body){bytes+=chunk.length;if(bytes>25000000)throw new AudioError('TEST_SIZE_LIMIT','The diagnostic tests recordings smaller than 25 MB.',422,false,stage);}
    const rangeTotal=Number(contentRange?.match(/^bytes 0-\d+\/(\d+)$/)?.[1]);
    if(bytes<131072||(expected>0&&bytes!==expected)||(full.status===206&&(!rangeTotal||rangeTotal!==bytes)))throw new AudioError('INCOMPLETE_AUDIO','The provider returned an incomplete audio body.',502,true,stage);
    checks.audioTransfer='passed';checks.seeking='pending';stage='seeking';progress();
    const seek=await fetch(media,{headers:{Origin:allowedOrigin,Range:'bytes=1024-2047'},signal:AbortSignal.timeout(35000)});
    const range=seek.headers.get('content-range'),chunk=await seek.arrayBuffer();
    if(seek.status!==206||chunk.byteLength!==1024||range!=='bytes 1024-2047/'+bytes)throw new AudioError('SEEK_FAILED','Audio arrived but byte-range seeking failed.',502,true,stage);
    checks.seeking='passed';
    const result={ok:true,status:'passed',stage:'complete',recordingId,checkedAt:new Date().toISOString(),durationMs:Date.now()-started,checks,metadata,bytes,seekStatus:seek.status};
    console.log('NOCTRA_AUDIO_PROBE '+JSON.stringify({ok:true,recordingId,bytes,durationMs:result.durationMs}));return result;
  }catch(error){
    if(checks.extraction==='pending')checks.extraction='failed';
    else if(checks.audioTransfer==='pending')checks.audioTransfer='failed';
    else if(checks.seeking==='pending')checks.seeking='failed';
    const failure=publicError(error,stage);
    const result={ok:false,status:'failed',stage,recordingId,checkedAt:new Date().toISOString(),durationMs:Date.now()-started,checks,error:failure,...(metadata?{metadata}:{}),bytes};
    console.warn('NOCTRA_AUDIO_PROBE '+JSON.stringify({ok:false,recordingId,stage,code:failure.code,durationMs:result.durationMs}));return result;
  }
}
