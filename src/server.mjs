import {createServer} from 'node:http';
import {createHash, createHmac, timingSafeEqual} from 'node:crypto';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {pathToFileURL} from 'node:url';
import {Extractor, mediaURL, validId, validFormat} from './extractor.mjs';
import {probeAudioGateway} from './probe.mjs';

const fail = (message, status = 400) => Object.assign(new Error(message), {status});
const hash = value => createHash('sha256').update(String(value)).digest();
const equal = (a, b) => timingSafeEqual(hash(a), hash(b));
export function signTicket(data, secret) {
  const payload = Buffer.from(JSON.stringify(data)).toString('base64url');
  return payload + '.' + createHmac('sha256', secret).update(payload).digest('base64url');
}
export function verifyTicket(ticket, secret, now = Date.now()) {
  if (typeof ticket !== 'string' || ticket.length > 800) throw fail('Invalid audio ticket.', 401);
  const [payload, signature, extra] = ticket.split('.');
  if (!payload || !signature || extra || !equal(signature, createHmac('sha256', secret).update(payload).digest('base64url'))) throw fail('Invalid audio ticket.', 401);
  let data; try {data = JSON.parse(Buffer.from(payload, 'base64url').toString());} catch {throw fail('Invalid audio ticket.',401);}
  if (!validId(data.id) || !validFormat(data.formatId) || !Number.isFinite(data.exp) || data.exp <= now) throw fail('Audio ticket expired. Resolve the recording again.', 401);
  return data;
}
async function body(req) {
  let data = ''; for await (const chunk of req) {data += chunk; if (Buffer.byteLength(data) > 4096) throw fail('Request is too large.',413);}
  try {const parsed=JSON.parse(data);if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw new Error();return parsed;} catch {throw fail('Expected a JSON object.');}
}
function send(res, status, data) {
  res.writeHead(status, {'Content-Type':'application/json', 'Cache-Control':'no-store', 'Referrer-Policy':'no-referrer'});
  res.end(JSON.stringify(data));
}
export function createAudioServer({apiKey, signingKey, publicBaseURL, allowedOrigin, extractor = new Extractor(), fetchImpl = fetch} = {}) {
  if (!apiKey || apiKey.length < 32 || !signingKey || signingKey.length < 32 || apiKey === signingKey) throw new Error('Set distinct API and signing secrets of at least 32 characters.');
  const base = new URL(publicBaseURL); if (!['http:','https:'].includes(base.protocol)) throw new Error('Invalid public audio service URL.');
  const rates = new Map(); let activeStreams = 0;
  const limit = key => {
    const now = Date.now(), old = rates.get(key), item = old && old.until > now ? old : {count:0,until:now+60000};
    if (++item.count > 30) throw fail('Too many audio requests. Try again shortly.',429);
    rates.set(key,item);
    if (rates.size > 2000) for (const [name,entry] of rates) if (entry.until <= now) rates.delete(name);
    if (rates.size > 3000) rates.delete(rates.keys().next().value);
  };
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://audio.internal');
      if (url.pathname === '/health' && req.method === 'GET') return send(res,200,{ok:true});
      if (url.pathname.startsWith('/internal/')) {
        if (!equal(req.headers.authorization || '', 'Bearer ' + apiKey)) throw fail('Unauthorized.',401);
        // This identity is supplied only by NOCTRA's authenticated server.
        limit('resolve:' + (req.headers['x-noctra-user'] || req.socket.remoteAddress || 'unknown'));
        if (url.pathname === '/internal/search' && req.method === 'POST') {
          const input = await body(req); return send(res,200,{tracks:await extractor.search(input.query)});
        }
        if (url.pathname === '/internal/resolve' && req.method === 'POST') {
          const input = await body(req);
          let id = input.videoId;
          // Query mode chooses the first candidate. The normal UI should search,
          // show candidates, then resolve the exact videoId chosen by its user.
          if (!id && input.query) id = (await extractor.search(input.query))[0]?.id;
          if (!validId(id)) throw fail('No matching recording was found.',404);
          const record = await extractor.resolve(id,{force:input.force === true});
          const expiresAt = Date.now() + 15*60000;
          const ticket = signTicket({id,formatId:record.formatId,exp:expiresAt},signingKey);
          return send(res,200,{id, title:record.title, artist:record.artist, thumbnail:record.thumbnail, duration:record.duration,
            mimeType:record.mimeType, codec:record.codec, bitrateKbps:record.bitrateKbps,
            audioUrl:new URL('/audio/'+ticket,base).href, expiresAt, sourceExpiresAt:record.sourceExpiresAt});
        }
        throw fail('Unknown audio endpoint.',404);
      }
      if (url.pathname.startsWith('/audio/') && ['GET','HEAD','OPTIONS'].includes(req.method)) {
        const origin = req.headers.origin;
        if (origin && origin !== allowedOrigin) throw fail('This origin is not allowed.',403);
        if (origin) {res.setHeader('Access-Control-Allow-Origin',origin);res.setHeader('Vary','Origin');}
        res.setHeader('Access-Control-Allow-Methods','GET, HEAD, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers','Range');
        res.setHeader('Access-Control-Expose-Headers','Content-Length, Content-Range, Accept-Ranges');
        res.setHeader('Cross-Origin-Resource-Policy','cross-origin');
        res.setHeader('Cache-Control','private, no-store');res.setHeader('Referrer-Policy','no-referrer');
        const ticket = verifyTicket(url.pathname.slice('/audio/'.length),signingKey);
        if (req.method === 'OPTIONS') {res.writeHead(204);return res.end();}
        if (activeStreams >= 24) throw fail('Audio capacity reached. Try again shortly.',503);
        const range = req.headers.range;
        if (range && (range.length > 80 || !/^bytes=(?:\d+-\d*|-\d+)$/.test(range))) throw fail('A single byte range is required.',416);
        activeStreams++;
        const abort = new AbortController(); const disconnect = () => abort.abort(); res.once('close',disconnect);
        try {
          // The selected format is pinned in the ticket. Refreshes must not change
          // the byte representation beneath an existing seek request.
          let record = await extractor.resolve(ticket.id,{formatId:ticket.formatId});
          let upstream;
          for (let attempt = 0; attempt < 2; attempt++) {
            let target = record.sourceUrl;
            for (let redirect = 0; redirect < 3; redirect++) {
              mediaURL(target); // Never accept an arbitrary proxy URL from clients.
              const timer = setTimeout(()=>abort.abort(),15000);
              try {upstream = await fetchImpl(target,{method:req.method,headers:{...record.headers,...(range?{Range:range}:{}),'Accept-Encoding':'identity'},redirect:'manual',signal:abort.signal});}
              finally {clearTimeout(timer);} // Header timeout must not truncate songs.
              if ([301,302,303,307,308].includes(upstream.status)) {
                const location = upstream.headers.get('location'); await upstream.body?.cancel();
                if (!location) throw fail('Invalid upstream redirect.',502);
                target = mediaURL(new URL(location,target).href).href; upstream = undefined; continue;
              }
              break;
            }
            if (!upstream) throw fail('Too many audio redirects.',502);
            if (attempt === 0 && [403,410].includes(upstream.status)) {
              await upstream.body?.cancel(); record = await extractor.resolve(ticket.id,{formatId:ticket.formatId,force:true}); continue;
            }
            break;
          }
          const expectedBytes=Number(new URL(record.sourceUrl).searchParams.get('clen'));
          const rangeTotal=Number(upstream.headers.get('content-range')?.match(/\/(\d+)$/)?.[1]);
          const fullLength=upstream.status===200?Number(upstream.headers.get('content-length')):0;
          const observedBytes=rangeTotal||fullLength;
          if(expectedBytes>0&&observedBytes>0&&observedBytes!==expectedBytes){await upstream.body?.cancel();throw fail('The provider returned an incomplete audio source. Try another recording.',502);}
          if (upstream.status === 416) {
            const contentRange = upstream.headers.get('content-range'); if (contentRange) res.setHeader('Content-Range',contentRange);
            await upstream.body?.cancel(); res.writeHead(416);return res.end();
          }
          if (![200,206].includes(upstream.status)) {await upstream.body?.cancel();throw fail('The audio source is unavailable. Resolve the recording again.',502);}
          res.statusCode = upstream.status;res.setHeader('Content-Type',record.mimeType);res.setHeader('X-Content-Type-Options','nosniff');
          for (const header of ['content-length','content-range','accept-ranges','etag','last-modified']) {const value=upstream.headers.get(header);if(value)res.setHeader(header,value);}
          if (req.method === 'HEAD' || !upstream.body) {await upstream.body?.cancel();return res.end();}
          await pipeline(Readable.fromWeb(upstream.body),res);
        } finally {activeStreams--;res.removeListener('close',disconnect);abort.abort();}
        return;
      }
      throw fail('Not found.',404);
    } catch (error) {
      if (res.headersSent) {res.destroy();return;}
      if (error.status === 429 || error.status === 503) res.setHeader('Retry-After','5');
      send(res,error.status || 502,{error:error.status ? error.message : 'Audio request failed. Try again shortly.'});
    }
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = createAudioServer({apiKey:process.env.AUDIO_API_KEY,signingKey:process.env.AUDIO_SIGNING_KEY,
    publicBaseURL:process.env.PUBLIC_AUDIO_BASE || process.env.RENDER_EXTERNAL_URL,allowedOrigin:process.env.NOCTRA_ORIGIN});
  server.listen(Number(process.env.PORT || 8080),'0.0.0.0',()=>{
    console.log('NOCTRA audio service listening.');
    if(validId(process.env.NOCTRA_PROBE_ID))void probeAudioGateway({port:server.address().port,apiKey:process.env.AUDIO_API_KEY,recordingId:process.env.NOCTRA_PROBE_ID,allowedOrigin:process.env.NOCTRA_ORIGIN});
  });
}
