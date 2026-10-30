import {spawn} from 'node:child_process';

// Kill the complete process group on timeout, including JavaScript solver children.
export function runProcess(binary,args,{timeout=90000,maxBuffer=8*1024*1024,...options}={}) {
  return new Promise((resolve,reject)=>{
    const childEnv={...process.env};delete childEnv.AUDIO_API_KEY;delete childEnv.AUDIO_SIGNING_KEY;
    const child=spawn(binary,args,{...options,env:childEnv,shell:false,windowsHide:true,detached:process.platform!=='win32',stdio:['ignore','pipe','pipe']});
    let stdout=[],bytes=0,stderr='',failure,settled=false,forceTimer,finishTimer;
    const stop=signal=>{try{if(child.pid&&process.platform!=='win32')process.kill(-child.pid,signal);else child.kill(signal);}catch{}};
    const finish=(error,code)=>{
      if(settled)return;settled=true;clearTimeout(timer);clearTimeout(finishTimer);
      if(error){Object.assign(error,{stderr,exitCode:typeof code==='number'?code:null});reject(error);}
      else resolve({stdout:Buffer.concat(stdout).toString('utf8'),stderr});
    };
    const abort=code=>{
      if(failure)return;failure=Object.assign(new Error('Extractor process stopped.'),{code,killed:code==='ETIMEDOUT'});
      stop('SIGTERM');forceTimer=setTimeout(()=>stop('SIGKILL'),500);forceTimer.unref();
      finishTimer=setTimeout(()=>finish(failure),1200);
    };
    const timer=setTimeout(()=>abort('ETIMEDOUT'),timeout);
    child.stdout.on('data',chunk=>{bytes+=chunk.length;if(bytes>maxBuffer)abort('MAXBUFFER');else stdout.push(chunk);});
    child.stderr.on('data',chunk=>{stderr=(stderr+chunk.toString()).slice(-65536);});
    child.once('error',error=>finish(error));
    child.once('close',code=>{if(!failure)clearTimeout(forceTimer);finish(failure||(code===0?null:Object.assign(new Error('Extractor exited unsuccessfully.'),{code:'PROCESS_EXIT'})),code);});
  });
}
