#!/usr/bin/env bash
set -euo pipefail

# XFCE applications abort when Selkies changes the virtual XRandR layout in
# this image. Openbox provides a stable window manager without owning display
# configuration, while the existing XFCE terminal and Thunar remain available.
export HOME=/config
export XDG_CONFIG_HOME=/config/.config

install -D -m 0644 /defaults/linux-gui-menu.xml \
  /config/.config/openbox/menu.xml

xsetroot -solid '#263238'

install -D -m 0644 /defaults/linux-gui-tint2rc \
  /config/.config/tint2/tint2rc

# Give a first-time user an obvious, usable window. The Openbox root menu
# (right click) also exposes the system terminal and browser launchers.
(
  sleep 1
  xfce4-terminal --maximize --title='Linux GUI' || true
) &

# tint2 is a few MB and only draws window buttons. Do not start xfce4-panel:
# it crash-loops after Selkies XRandR changes (black screen, 2026-07-17).
(
  sleep 1
  tint2 -c /config/.config/tint2/tint2rc || true
) &

exec openbox-session
