// Optional one-shot production verification. Never logs keys or signed URLs.
export async function probeAudioGateway({port, apiKey, recordingId, allowedOrigin}) {
  const base='http://127.0.0.1:'+port;
  try {
    const resolved=await fetch(base+'/internal/resolve',{method:'POST',headers:{Authorization:'Bearer '+apiKey,'Content-Type':'application/json','X-Noctra-User':'deployment-probe'},body:JSON.stringify({videoId:recordingId}),signal:AbortSignal.timeout(45000)});
    if(!resolved.ok) throw new Error('resolve_status_'+resolved.status);
    const metadata=await resolved.json();
    const media=base+new URL(metadata.audioUrl).pathname;
    const full=await fetch(media,{headers:{Origin:allowedOrigin},signal:AbortSignal.timeout(90000)});
    if(full.status!==200||!full.headers.get('content-type')?.startsWith('audio/')) throw new Error('media_status_'+full.status);
    const expected=Number(full.headers.get('content-length'));
    let bytes=0;for await(const chunk of full.body){bytes+=chunk.length;if(bytes>25000000)throw new Error('probe_size_limit');}
    if(bytes<131072||(expected>0&&bytes!==expected)) throw new Error('incomplete_audio');
    const seek=await fetch(media,{headers:{Origin:allowedOrigin,Range:'bytes=1024-2047'},signal:AbortSignal.timeout(20000)});
    const range=seek.headers.get('content-range');
    const chunk=await seek.arrayBuffer();
    if(seek.status!==206||chunk.byteLength!==1024||range!=='bytes 1024-2047/'+bytes) throw new Error('seek_failed');
    console.log('NOCTRA_AUDIO_PROBE '+JSON.stringify({ok:true,recordingId,bytes,mimeType:metadata.mimeType,seekStatus:seek.status}));
  } catch(error) {
    const reason=/^(resolve_status_\d+|media_status_\d+|incomplete_audio|probe_size_limit|seek_failed)$/.test(error.message)?error.message:'network_or_timeout';
    console.warn('NOCTRA_AUDIO_PROBE '+JSON.stringify({ok:false,recordingId,reason}));
  }
}
