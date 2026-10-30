FROM node:24-bookworm-slim
ARG YTDLP_VERSION=2026.10.26
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-venv ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && python3 -m venv /opt/ytdlp \
    && /opt/ytdlp/bin/pip install --no-cache-dir "yt-dlp[default]==$YTDLP_VERSION" \
    && /opt/ytdlp/bin/yt-dlp --version
ENV YTDLP_BIN=/opt/ytdlp/bin/yt-dlp YTDLP_VERSION=$YTDLP_VERSION PORT=8080
WORKDIR /app
COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src
USER node
EXPOSE 8080
CMD ["node", "src/server.mjs"]
