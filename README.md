# NOCTRA YouTube audio service

This Node service is integrated with NOCTRA's authenticated playback API. It is
included in the source repository with a Render Docker Blueprint. External
Render is connected. Deployment is pending a Render-accessible source repository
and a successful live audio test.

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

## Endpoints

- GET /health: service health.
- POST /internal/search: authenticated query search; falls back to general YouTube
  search. NOCTRA normally uses its existing YouTube Music catalog.
- POST /internal/resolve: authenticated videoId (or first-result query), metadata
  and a short-lived signed audio URL. Resolver concurrency is capped at two.
- GET/HEAD /audio/:ticket: audio-only byte relay, pinned format ID, byte ranges,
  one pre-stream refresh after 403/410, disconnect cancellation, origin checks.

The service accepts only validated recording IDs and audio-only formats; it does
not expose arbitrary URL extraction or an open proxy. It prefers direct AAC/M4A
and never falls back to a format containing video. Incomplete upstream media is
rejected when its byte length contradicts the signed source's content length.

Tests: `node --test test/audio.test.mjs`. These use fixture extractor results and
an upstream transport and do not assert that YouTube accepts a new host's IP.

Five test groups cover format/host validation, extraction de-duplication, signed
tickets, auth, expiry, seeking, upstream refresh, CORS and truncated audio.
