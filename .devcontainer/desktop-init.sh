#!/bin/sh
set -eu

# The X11 socket and system bus need root setup; Electron and VNC run as node.
/etc/init.d/dbus start
install -d -o root -g root -m 1777 /tmp/.X11-unix

runuser -u node -- sh -c '
    umask 077
    mkdir -p "$HOME/.config/tigervnc"
    mkdir -p "$HOME/.fluxbox"
    printf "session.styleFile: /usr/share/fluxbox/styles/BlueNight\n" > "$HOME/.fluxbox/init"
    printf "%s\n" "$VNC_PASSWORD" | vncpasswd -f > "$HOME/.config/tigervnc/passwd"
    exec tigervncserver :1 -geometry 1440x768 -depth 16 -rfbport 5901 -localhost yes -passwd "$HOME/.config/tigervnc/passwd" -fg
' &
vnc_pid=$!

# A listening noVNC proxy cannot prove that the authenticated X11 desktop started.
attempt=0
until runuser -u node -- xdpyinfo -display "$DISPLAY" >/dev/null 2>&1; do
    if ! kill -0 "$vnc_pid" 2>/dev/null; then
        wait "$vnc_pid"
        exit 1
    fi
    attempt=$((attempt + 1))
    if [ "$attempt" -ge 100 ]; then
        printf '%s\n' 'Timed out waiting for the VNC X11 desktop.' >&2
        exit 1
    fi
    sleep 0.1
done

runuser -u node -- /usr/share/novnc/utils/novnc_proxy --listen 6080 --vnc localhost:5901 &

exec "$@"
