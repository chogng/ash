#!/bin/sh
set -eu

# The X11 socket and system bus need root setup; Electron and VNC run as node.
/etc/init.d/dbus start
install -d -o root -g root -m 1777 /tmp/.X11-unix

runuser -u node -- sh -c '
    umask 077
    mkdir -p "$HOME/.vnc"
    mkdir -p "$HOME/.fluxbox"
    printf "session.styleFile: /usr/share/fluxbox/styles/BlueNight\n" > "$HOME/.fluxbox/init"
    printf "%s\n" "$VNC_PASSWORD" | vncpasswd -f > "$HOME/.vnc/passwd"
    exec tigervncserver :1 -geometry 1440x768 -depth 16 -rfbport 5901 -localhost yes -passwd "$HOME/.vnc/passwd" -fg
' &

runuser -u node -- /usr/share/novnc/utils/novnc_proxy --listen 6080 --vnc localhost:5901 &

exec "$@"
