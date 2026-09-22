# BishopTV em container: o Electron roda num display virtual (Xvfb) e a tela
# é servida no navegador via noVNC. Veja docker-compose.yml.
FROM node:20-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive

# Bibliotecas de runtime do Electron/Chromium + display virtual + VNC web.
RUN apt-get update && apt-get install -y --no-install-recommends \
      libgtk-3-0 libnss3 libasound2 libpulse0 libgbm1 libdrm2 libxss1 libxtst6 \
      libxkbcommon0 libxcomposite1 libxdamage1 libxrandr2 libcups2 libatk-bridge2.0-0 \
      xvfb x11vnc openbox novnc websockify \
      fonts-dejavu-core fonts-noto-color-emoji ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
# O Electron é devDependency: o binário vem no postinstall, então não dá para
# usar --omit=dev.
RUN npm ci && npm cache clean --force

COPY . .

COPY docker/entrypoint.sh /usr/local/bin/bishoptv-entrypoint
# Protege contra CRLF caso o arquivo tenha passado por um checkout no Windows.
RUN sed -i 's/\r$//' /usr/local/bin/bishoptv-entrypoint \
    && chmod +x /usr/local/bin/bishoptv-entrypoint \
    && mkdir -p /tmp/.X11-unix && chmod 1777 /tmp/.X11-unix \
    && mkdir -p /home/node/.config/BishopTV /home/node/listas \
    && chown -R node:node /home/node

USER node

ENV SCREEN_RESOLUTION=1440x900 \
    NOVNC_PORT=6080

EXPOSE 6080

ENTRYPOINT ["bishoptv-entrypoint"]
