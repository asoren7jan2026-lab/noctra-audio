import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const execute = promisify(execFile);
export const AUDIO_FORMAT = 'bestaudio[ext=m4a][protocol=https]/bestaudio[protocol=https]';
export const validId = id => typeof id === 'string' && /^[A-Za-z0-9_-]{11}$/.test(id);
export const validFormat = format => typeof format === 'string' && /^[A-Za-z0-9_-]{1,32}$/.test(format);

export function mediaURL(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.port ||
      !(url.hostname === 'googlevideo.com' || url.hostname.endsWith('.googlevideo.com'))) {
    throw new Error('The extractor returned an unsupported media host.');
  }
  return url;
}
export function normalizeAudio(info, id, now = Date.now()) {
  if (info.id !== id || info.vcodec !== 'none' || !info.acodec || info.acodec === 'none' || info.is_live ||
      !validFormat(info.format_id) || !['m4a', 'webm', 'mp4', 'aac', 'mp3', 'ogg'].includes(info.ext)) {
    throw new Error('A direct audio-only format is unavailable for this recording.');
  }
  const url = mediaURL(info.url);
  const expiry = Number(url.searchParams.get('expire')) * 1000;
  const sourceExpiresAt = Number.isFinite(expiry) && expiry > 0 ? expiry : null;
  if (sourceExpiresAt && sourceExpiresAt < now + 30000) throw new Error('The extracted audio URL is already expiring.');
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
    cacheUntil:Math.min(now + 120000, sourceExpiresAt ? sourceExpiresAt - 30000 : now + 60000),
  };
}

export class Extractor {
  constructor({run = execute, binary = process.env.YTDLP_BIN || 'yt-dlp', concurrency = 2, maxCache = 200} = {}) {
    this.run = run; this.binary = binary; this.concurrency = concurrency; this.maxCache = maxCache;
    this.active = 0; this.cache = new Map(); this.pending = new Map();
  }
  async command(extra) {
    if (this.active >= this.concurrency) throw Object.assign(new Error('Audio resolver is busy. Try again shortly.'), {status:503});
    this.active++;
    try {
      const {stdout} = await this.run(this.binary, [
        '--ignore-config', '--no-playlist', '--skip-download', '--dump-single-json', '--no-progress',
        '--socket-timeout', '10', '--retries', '1', '--extractor-retries', '1', '--js-runtimes', 'node',
        ...(process.env.YTDLP_USE_SYSTEM_CA === '1' ? ['--compat-options','no-certifi'] : []), ...extra,
      ], {timeout:35000, killSignal:'SIGKILL', maxBuffer:8*1024*1024, shell:false, windowsHide:true});
      return JSON.parse(stdout);
    } catch (error) {
      if (error.status) throw error;
      // Do not expose extraction logs, cookies, or signed CDN URLs to visitors.
      const detail=String(error.stderr||'');
      const reason=error.killed?'timeout':/confirm you.re not a bot|Sign in to confirm|LOGIN_REQUIRED/i.test(detail)?'provider_verification':/Requested format is not available|No video formats found/i.test(detail)?'audio_format_unavailable':/not available|unavailable|Private video|removed/i.test(detail)?'recording_unavailable':'extractor_error';
      console.warn('NOCTRA_EXTRACTOR '+JSON.stringify({reason,exitCode:typeof error.code==='number'?error.code:null}));
      throw Object.assign(new Error('Audio extraction failed. This recording or the provider may be unavailable.'), {status:502});
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
    if (!force && cached?.cacheUntil > Date.now()) return cached;
    if (this.pending.has(key)) return this.pending.get(key);
    const job = (async () => {
      const info = await this.command(['-f', formatId || AUDIO_FORMAT, '--', 'https://music.youtube.com/watch?v=' + id]);
      const record = normalizeAudio(info, id);
      this.cache.set(key, record); this.cache.set(id + ':' + record.formatId, record);
      while (this.cache.size > this.maxCache) this.cache.delete(this.cache.keys().next().value);
      return record;
    })();
    this.pending.set(key, job);
    try {return await job;} finally {this.pending.delete(key);}
  }
}
