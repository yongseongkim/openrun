#!/bin/sh
set -eu
umask 077
mkdir -p "$OPENRUN_PROFILE_DIR" "$OPENRUN_SESSION_DIR" "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME" "$OPENRUN_DATA_DIR"
Xvfb "$DISPLAY" -screen 0 1280x900x24 -nolisten tcp > /tmp/openrun-display.log 2>&1 &
display_pid=$!
attempt=0
until xdpyinfo -display "$DISPLAY" >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 50 ] || ! kill -0 "$display_pid" 2>/dev/null; then
    echo 'Virtual display failed to start' >&2
    exit 1
  fi
  sleep 0.1
done
openbox > /tmp/openrun-window-manager.log 2>&1 &
x11vnc -display "$DISPLAY" -localhost -nopw -forever -shared -rfbport 5900 \
  -noxdamage -quiet > /tmp/openrun-vnc.log 2>&1 &
exec "$@"
