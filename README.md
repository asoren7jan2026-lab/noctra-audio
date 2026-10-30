# NOCTRA YouTube audio service

This Node service is integrated with NOCTRA's authenticated playback API. It is
deployed on Render at https://noctra-audio.onrender.com. Its standalone source is
https://github.com/asoren7jan2026-lab/noctra-audio. The NOCTRA server stores its
connection URL and API key in production runtime configuration.

The live Site uses one persistent HTMLAudioElement. YouTube video runtimes,
iframes, player scripts and floating video UI have been removed. The existing
catalog remains available; when direct YouTube audio cannot be resolved, the
server may play an unambiguous matching JioSaavn recording. It requires matching
title, artist, duration and explicit version and reports the actual provider.
Unverified matches fail with an audio error.

## Service configuration

Use this directory as the container build root. The Dockerfile installs Node 24,
Python and yt-dlp with EJS support. It runs as a non-root user. Required secrets:

- AUDIO_API_KEY: at least 32 random characters, shared only with NOCTRA's server.
- AUDIO_SIGNING_KEY: a separate secret of at least 32 random characters.
- PUBLIC_AUDIO_BASE: this service's public HTTPS origin. On Render this is
  optional; the server uses Render's RENDER_EXTERNAL_URL automatically.
- NOCTRA_ORIGIN: https://noctra-listen.asoren7jan2031.chatgpt.site
- PORT: supplied by the host, otherwise 8080.

Optional YTDLP_USE_SYSTEM_CA=1 selects the host's trusted system certificate store
where a legitimate custom CA is absent from certifi. TLS verification stays on.
Never disable certificate verification.

Set AUDIO_SERVICE_URL and AUDIO_API_KEY in the Site's runtime secret store after
hosting this service. AUDIO_PUBLIC_BASE is optional if the public stream origin
is different from the internal service origin. No secret is sent to the browser.
No database migration or library ID conversion is required. Test on the actual
host before enabling it: an extractor metadata response alone is not proof that
full audio is retrievable.

## Render deployment

The repository-root `render.yaml` configures a Docker web service in Singapore,
with this directory as its build root and `/health` as its health check. It selects
the Free plan and adds no database or persistent disk. Supply AUDIO_API_KEY
through Render's secret settings and copy the same value to the Site's runtime
secret store. Render generates a separate signing secret; neither is committed.

The source must be available to Render through a supported Git provider, or a
container must be published to a registry Render can read. The Site's private,
short-lived Git write credential must never be reused as a deployment credential.

Render Free sleeps after 15 minutes idle and can take about a minute to wake.
NOCTRA allows extra time for an onrender.com backend to wake before extraction.
Streaming counts toward Render traffic limits; this free configuration is for
initial validation. Verify full audio and seeking on the deployed host before
marking direct YouTube playback ready.

## Extraction settings

The Docker build pins yt-dlp 2026.10.26 with its default dependencies, including
the EJS components, and enables the container's exact Node executable for the
JavaScript challenge. It uses yt-dlp's maintained default YouTube clients; it
does not force an outdated Android profile or try every client.

Requests use IPv4, a 20-second socket timeout, three HTTP retries and two known
extractor retries with exponential backoff capped at eight seconds. The process
has a 90-second total deadline and one concurrent extraction on the Free plan.
On timeout the process group, including solver children, is terminated.
YTDLP_TIMEOUT_MS optionally changes the deadline between 10 and 150 seconds.

The format selector requires vcodec=none, a nonempty audio codec and direct HTTPS.
It prefers M4A/AAC, then another audio-only format. It never selects a mixed
audio/video fallback. The default user-agent follows the pinned yt-dlp release;
an operator can provide YTDLP_USER_AGENT as a validated single-line override.

Failures return error, code, retryable and stage. Verification requirements,
rate limits, region restrictions, missing formats, TLS errors and timeouts are
separate results. TLS verification stays enabled. The Site waits for Render to
wake before sending the extraction request and preserves these error messages.

## Endpoints

- GET /health: process health and the latest diagnostic status.
- GET /test: starts one diagnostic for NOCTRA_PROBE_ID on first access, immediately
  returns 202 while running, then reports extraction, full audio transfer and
  seeking separately. Refreshes reuse the result and do not run more extractors.
  A successful result contains basic metadata and a short-lived gateway audio URL.
  Keys and raw signed CDN URLs are never returned. It does not run at startup.
- POST /internal/test: authenticated JSON videoId starts a fresh diagnostic.
  This is the only way to choose another recording or rerun it without a restart.
  GET /test shows its progress. The public test does not accept arbitrary queries.
- POST /internal/search: authenticated query search; falls back to general YouTube
  search. NOCTRA normally uses its existing YouTube Music catalog.
- POST /internal/resolve: authenticated videoId (or first-result query), metadata
  and a short-lived signed audio URL. Resolver concurrency is capped at one.
- GET/HEAD /audio/:ticket: audio-only byte relay, pinned format ID, byte ranges,
  one shared refresh after 403/410, disconnect cancellation, origin checks.
  Sources with a signed content length use ordered 256 KiB upstream byte ranges,
  with bounded prefetch and a 45-second deadline per part. The client still gets
  one normal audio response; seeking requests retain their exact byte range.

The service accepts only validated recording IDs and audio-only formats; it does
not expose arbitrary URL extraction or an open proxy. It prefers direct AAC/M4A
and never falls back to a format containing video. Incomplete upstream media is
rejected when its byte length contradicts the signed source's content length.

Tests: `node --test`. These use fixture extractor results and
an upstream transport and do not assert that YouTube accepts a new host's IP.

Five test groups cover format/host validation, extraction de-duplication, signed
tickets, auth, expiry, seeking, upstream refresh, CORS and truncated audio.
Five additional groups cover error classification, capacity recovery, real
subprocess termination, complete 206 audio delivery, cached diagnostics and
propagation of provider verification errors.
