#!/bin/sh
set -e

DATA_DIR="$HOME/.config/BishopTV"
mkdir -p "$DATA_DIR"

# Se o container parou sem o Electron fechar direito, a trava de instância
# única fica para trás e o app acha que já está aberto — e encerra na hora.
rm -f "$DATA_DIR"/Singleton*

# Sem DISPLAY externo (modo padrão): sobe um X virtual e expõe via noVNC.
# Com DISPLAY definido (ex.: docker-compose.wslg.yml), usa a tela do host.
if [ -z "$DISPLAY" ]; then
  export DISPLAY=:99
  Xvfb :99 -screen 0 "${SCREEN_RESOLUTION}x24" -nolisten tcp &

  i=0
  while [ ! -e /tmp/.X11-unix/X99 ] && [ "$i" -lt 50 ]; do
    sleep 0.1
    i=$((i + 1))
  done

  # Gerenciador de janelas mínimo: sem ele, maximizar/tela cheia não funcionam.
  openbox &

  if [ -n "$VNC_PASSWORD" ]; then
    x11vnc -storepasswd "$VNC_PASSWORD" "$HOME/.vncpass" >/dev/null 2>&1
    VNC_AUTH="-rfbauth $HOME/.vncpass"
  else
    VNC_AUTH="-nopw"
  fi
  # shellcheck disable=SC2086
  x11vnc -display :99 -forever -shared -localhost -rfbport 5900 $VNC_AUTH -quiet &
  websockify --web /usr/share/novnc "$NOVNC_PORT" localhost:5900 >/dev/null 2>&1 &

  echo "BishopTV: abra http://localhost:${NOVNC_PORT}/vnc.html?autoconnect=1&resize=scale"
fi

# --no-sandbox: o sandbox do Chromium não funciona dentro do container sem
# privilégios extras.
exec /app/node_modules/.bin/electron /app --no-sandbox --disable-gpu "$@"
