FROM node:26.13.0-bookworm-slim
ENV DEBIAN_FRONTEND=noninteractive \
    PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers \
    DISPLAY=:99 \
    OPENRUN_HOST=0.0.0.0 \
    OPENRUN_PROFILE_DIR=/data/profiles \
    OPENRUN_SESSION_DIR=/data/.auth \
    OPENRUN_DATA_DIR=/data/app \
    XDG_CONFIG_HOME=/data/config \
    XDG_CACHE_HOME=/data/cache \
    OPENRUN_BROWSER_CHANNEL=chromium
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl xvfb x11vnc x11-utils openbox tini \
    && rm -rf /var/lib/apt/lists/*
RUN arch="$(dpkg --print-architecture)" \
    && curl -fsSL "https://github.com/getsops/sops/releases/download/v3.13.2/sops-v3.13.2.linux.${arch}" -o /tmp/sops \
    && curl -fsSL "https://github.com/getsops/sops/releases/download/v3.13.2/sops-v3.13.2.checksums.txt" -o /tmp/sops-checksums \
    && expected="$(awk -v file="sops-v3.13.2.linux.${arch}" '$2 == file { print $1 }' /tmp/sops-checksums)" \
    && test -n "$expected" && printf '%s  /tmp/sops\n' "$expected" | sha256sum --check \
    && install -m 755 /tmp/sops /usr/local/bin/sops && rm /tmp/sops /tmp/sops-checksums
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npx playwright install --with-deps chromium \
    && chmod -R o+rx /opt/pw-browsers \
    && mkdir -p /data && chmod 1777 /data && chown -R node:node /app
COPY --chown=node:node src ./src
COPY --chown=node:node public ./public
COPY --chown=node:node .sops.yaml ./
COPY --chown=node:node deploy/entrypoint.sh ./deploy/entrypoint.sh
RUN chmod 755 /app/deploy/entrypoint.sh
USER node
EXPOSE 4340
ENTRYPOINT ["tini", "-g", "--", "/app/deploy/entrypoint.sh"]
CMD ["node", "src/remote/main.ts"]
