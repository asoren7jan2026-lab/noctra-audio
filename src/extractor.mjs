import {runProcess} from './process.mjs';
import {AudioError,extractionError,diagnosticLine} from './errors.mjs';
export const AUDIO_FORMAT = 'bestaudio[vcodec=none][acodec!=none][ext=m4a][protocol=https]/bestaudio[vcodec=none][acodec!=none][protocol=https]';
export const validId = id => typeof id === 'string' && /^[A-Za-z0-9_-]{11}$/.test(id);
export const validFormat = format => typeof format === 'string' && /^[A-Za-z0-9_-]{1,32}$/.test(format);

export function mediaURL(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.port ||
      !(url.hostname === 'googlevideo.com' || url.hostname.endsWith('.googlevideo.com'))) {
    throw new AudioError('UNSUPPORTED_MEDIA_HOST','The extractor returned an unsupported audio host.');
  }
  return url;
}
export function normalizeAudio(info, id, now = Date.now()) {
  if (info.id !== id || info.vcodec !== 'none' || !info.acodec || info.acodec === 'none' || info.is_live ||
      !validFormat(info.format_id) || !['m4a', 'webm', 'mp4', 'aac', 'mp3', 'ogg'].includes(info.ext)) {
    throw new AudioError('AUDIO_FORMAT_UNAVAILABLE','A direct audio-only format is unavailable for this recording.',422);
  }
  const url = mediaURL(info.url);
  const expiry = Number(url.searchParams.get('expire')) * 1000;
  const sourceExpiresAt = Number.isFinite(expiry) && expiry > 0 ? expiry : null;
  if (sourceExpiresAt && sourceExpiresAt < now + 30000) throw new AudioError('SOURCE_EXPIRED','The extracted audio URL is already expiring. Resolve it again.',502,true);
  const mimeTypes = {m4a:'audio/mp4',mp4:'audio/mp4',webm:'audio/webm',aac:'audio/aac',mp3:'audio/mpeg',ogg:'audio/ogg'};
  const headers = {};
  for (const [key, value] of Object.entries(info.http_headers || {})) {
    if (['user-agent','origin','referer'].includes(key.toLowerCase()) && typeof value === 'string' && !/[\r\n]/.test(value)) headers[key] = value;
  }
  return {
    id, title:info.track || info.title || '', artist:info.artist || info.creator || info.uploader || '',
    thumbnail:info.thumbnail || '', duration:Number(info.duration) || 0,
    formatId:info.format_id, codec:info.acodec, bitrateKbps:info.abr || null,
    mimeType:mimeTypes[info.ext], sourceUrl:url.href, sourceExpiresAt, headers,
    cacheUntil:Math.min(now + 600000, sourceExpiresAt ? sourceExpiresAt - 60000 : now + 60000),
  };
}

export class Extractor {
  constructor({run = runProcess, binary = process.env.YTDLP_BIN || 'yt-dlp', concurrency = 1, maxCache = 200, timeoutMs = Number(process.env.YTDLP_TIMEOUT_MS)||90000, now=Date.now} = {}) {
    this.run = run; this.binary = binary; this.concurrency = concurrency; this.maxCache = maxCache;
    this.timeoutMs=Math.max(10000,Math.min(150000,timeoutMs));
    this.active = 0; this.cache = new Map(); this.pending = new Map();this.now=now;this.pause=null;
  }
  availability(){
    if(this.pause&&this.pause.retryAt<=this.now())this.pause=null;
    return this.pause?{available:false,code:this.pause.code,message:this.pause.message,stage:this.pause.stage,retryAt:this.pause.retryAt,retryAfterSeconds:Math.max(1,Math.ceil((this.pause.retryAt-this.now())/1000))}:{available:true};
  }
  pauseFor(error){
    if(!['UPSTREAM_RATE_LIMIT','PROVIDER_VERIFICATION_REQUIRED'].includes(error.code))return error;
    error.retryAt=this.now()+600000;this.pause=error;return error;
  }
  assertAvailable(){
    if(!this.availability().available){const error=new AudioError(this.pause.code,this.pause.message,this.pause.status,this.pause.retryable,this.pause.stage);error.retryAt=this.pause.retryAt;throw error;}
  }
  async command(extra) {
    this.assertAvailable();
    if (this.active >= this.concurrency) throw new AudioError('EXTRACTOR_BUSY','The audio resolver is processing another recording. Retry shortly.',503,true);
    this.active++;
    try {
      const {stdout} = await this.run(this.binary, [
        '--ignore-config', '--no-playlist', '--skip-download', '--dump-single-json', '--no-progress',
        '--force-ipv4','--socket-timeout', '20', '--retries', '3', '--extractor-retries', '2',
        '--retry-sleep','http:exp=1:8','--retry-sleep','extractor:exp=1:8',
        '--no-js-runtimes','--js-runtimes', 'node:'+process.execPath,
        '--extractor-args','youtube:player_client=default',
        ...(process.env.YTDLP_USER_AGENT&&process.env.YTDLP_USER_AGENT.length<=512&&!/[\r\n]/.test(process.env.YTDLP_USER_AGENT)?['--add-headers','User-Agent:'+process.env.YTDLP_USER_AGENT]:[]),
        ...(process.env.YTDLP_USE_SYSTEM_CA === '1' ? ['--compat-options','no-certifi'] : []), ...extra,
      ], {timeout:this.timeoutMs, maxBuffer:8*1024*1024, shell:false, windowsHide:true});
      try{return JSON.parse(stdout);}catch{throw new AudioError('INVALID_EXTRACTOR_RESPONSE','The extractor returned invalid metadata.',502);}
    } catch (error) {
      const failure=this.pauseFor(extractionError(error,this.timeoutMs));
      console.warn('NOCTRA_EXTRACTOR '+JSON.stringify({code:failure.code,exitCode:error.exitCode??null,diagnostic:diagnosticLine(error.stderr)}));
      throw failure;
    } finally {this.active--;}
  }
  async search(query) {
    if (typeof query !== 'string' || !query.trim() || query.length > 160) throw Object.assign(new Error('Enter a query of 1–160 characters.'), {status:400});
    const result = await this.command(['--flat-playlist', '--', 'ytsearch5:' + query.trim()]);
    return (result.entries || []).filter(item => validId(item.id)).map(item => ({
      id:item.id, title:item.track || item.title || '', artist:item.artist || item.uploader || item.channel || '',
      thumbnail:item.thumbnail || item.thumbnails?.at(-1)?.url || '', duration:Number(item.duration) || 0,
    }));
  }
  async resolve(id, {formatId, force = false} = {}) {
    if (!validId(id) || (formatId && !validFormat(formatId))) throw Object.assign(new Error('Invalid recording identifier.'), {status:400});
    const key = id + ':' + (formatId || 'preferred');
    const cached = this.cache.get(key);
    if (!force && cached?.cacheUntil > this.now()) return cached;
    if (this.pending.has(key)) return this.pending.get(key);
    const job = (async () => {
      const info = await this.command(['-f', formatId || AUDIO_FORMAT, '--', 'https://music.youtube.com/watch?v=' + id]);
      const record = normalizeAudio(info, id,this.now());
      this.cache.set(key, record); this.cache.set(id + ':' + record.formatId, record);
      while (this.cache.size > this.maxCache) this.cache.delete(this.cache.keys().next().value);
      return record;
    })();
    this.pending.set(key, job);
    try {return await job;} finally {this.pending.delete(key);}
  }
}
