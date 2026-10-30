export class AudioError extends Error {
  constructor(code, message, status = 502, retryable = false, stage = 'extraction') {
    super(message);this.name='AudioError';this.code=code;this.status=status;this.retryable=retryable;this.stage=stage;
  }
}
export function diagnosticLine(stderr='') {
  const lines=String(stderr).replace(/\x1b\[[0-9;]*m/g,'').split(/\r?\n/).filter(Boolean);
  const line=lines.findLast(value=>/^ERROR:/i.test(value))||lines.at(-1)||'';
  return line.replace(/https?:\/\/[^\s]+/gi,'[upstream URL]')
    .replace(/((?:authorization|cookie|token|signature|api[_-]?key|sig)\s*[:=])\s*[^\s;,]+/gi,'$1[redacted]')
    .slice(0,500);
}
export function extractionError(error, timeoutMs=90000) {
  if(error instanceof AudioError)return error;
  const text=String(error.stderr||error.message||'');
  if(error.code==='ENOENT')return new AudioError('EXTRACTOR_NOT_INSTALLED','The audio extractor is missing on the server.',503);
  if(error.killed||error.code==='ETIMEDOUT')return new AudioError('EXTRACTION_TIMEOUT','Audio extraction exceeded '+Math.round(timeoutMs/1000)+' seconds. Retry shortly.',504,true);
  if(error.code==='MAXBUFFER')return new AudioError('EXTRACTOR_OUTPUT_LIMIT','The extractor returned too much metadata for this server.',502);
  // Prefer the final failure over earlier retry warnings in the same stderr.
  const final=text.replace(/\x1b\[[0-9;]*m/g,'').split(/\r?\n/).findLast(line=>/^ERROR:/i.test(line))||text;
  if(/Sign in to confirm|confirm you.re not a bot|LOGIN_REQUIRED|authentication required/i.test(final))return new AudioError('PROVIDER_VERIFICATION_REQUIRED','YouTube requires verification for this server. Choose JioSaavn or another audio source in Settings.',403);
  if(/HTTP Error 429|Too Many Requests|rate.?limit/i.test(final))return new AudioError('UPSTREAM_RATE_LIMIT','YouTube is limiting this server. New requests are paused; choose another audio source or try later.',429,true);
  if(/not available in your country|not made.*available in your country|geo.?restricted/i.test(text))return new AudioError('REGION_RESTRICTED','This recording is unavailable in the server region.',451);
  if(/private video|has been removed|has been deleted/i.test(text))return new AudioError('RECORDING_UNAVAILABLE','YouTube reports this recording as private or removed.',404);
  if(/Requested format.*not available|No video formats found|No formats found/i.test(text))return new AudioError('AUDIO_FORMAT_UNAVAILABLE','No supported direct audio-only format is available for this recording.',422);
  if(/certificate verify|CERTIFICATE_VERIFY|SSL certificate/i.test(text))return new AudioError('UPSTREAM_TLS_ERROR','The server could not verify the audio provider certificate.',502);
  if(/JavaScript runtime|challenge solving failed|signature extraction failed|nsig extraction failed/i.test(text))return new AudioError('JAVASCRIPT_CHALLENGE_FAILED','The extractor could not complete the provider JavaScript challenge.',502);
  if(/HTTP Error 403|HTTP Error 410/i.test(text))return new AudioError('UPSTREAM_ACCESS_DENIED','The provider rejected access to this audio source.',502);
  if(/timed? ?out|TimeoutError/i.test(text))return new AudioError('UPSTREAM_TIMEOUT','The audio provider timed out. Try again shortly.',504,true);
  if(/Unable to download|RemoteDisconnected|Connection|Name or service not known|Temporary failure in name|ENOTFOUND|EAI_AGAIN/i.test(text))return new AudioError('UPSTREAM_NETWORK_ERROR','The server could not reach the audio provider. Try again shortly.',502,true);
  if(/Video unavailable|This video is not available|This content isn.t available/i.test(text))return new AudioError('SOURCE_UNAVAILABLE','YouTube reports this recording as unavailable from the server.',502);
  return new AudioError('EXTRACTION_FAILED','The audio extractor failed to return playable audio. Check the diagnostic endpoint for the failing stage.',502,true);
}
export function publicError(error, stage='request') {
  if(error instanceof AudioError)return {error:error.message,code:error.code,retryable:error.retryable,stage:error.stage,...(error.retryAt?{retryAt:error.retryAt,retryAfterSeconds:Math.max(1,Math.ceil((error.retryAt-Date.now())/1000))}:{})};
  if(error?.name==='TimeoutError'||error?.name==='AbortError')return {error:'The audio provider request timed out.',code:'UPSTREAM_TIMEOUT',retryable:true,stage};
  if(Number.isInteger(error?.status))return {error:error.message,code:'REQUEST_REJECTED',retryable:[429,503,504].includes(error.status),stage};
  return {error:'The audio provider connection failed. Try again shortly.',code:'UPSTREAM_NETWORK_ERROR',retryable:true,stage};
}
