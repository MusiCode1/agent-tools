#!/usr/bin/env python3
"""Build-time loopback bindings. Fail on upstream drift instead of exposing GUI."""
from pathlib import Path


def replace_exact(path, replacements):
    text = path.read_text()
    for old, new in replacements:
        if text.count(old) != 1:
            raise SystemExit(f"Unexpected upstream template: {path}: {old!r}")
        text = text.replace(old, new)
    path.write_text(text)


replace_exact(Path('/defaults/default.conf'), [
    ('listen 3000 default_server;', 'listen 127.0.0.1:3000 default_server;'),
    ('listen [::]:3000 default_server;', 'listen [::1]:3000 default_server;'),
    ('listen 3001 ssl;', 'listen 127.0.0.1:3001 ssl;'),
    ('listen [::]:3001 ssl;', 'listen [::1]:3001 ssl;'),
])
sources = list(Path('/lsiopy/lib').glob('python*/site-packages/selkies/selkies.py'))
if len(sources) != 1:
    raise SystemExit('Expected one Selkies source file')
# This Selkies version ignores --addr in these two listeners. Keep both local,
# including the optional control API; nginx is the only remote entry point.
replace_exact(sources[0], [
    ('"0.0.0.0",\n                    self.port,', '"127.0.0.1",\n                    self.port,'),
    ("web.TCPSite(control_plane_runner, '0.0.0.0', settings.control_port)",
     "web.TCPSite(control_plane_runner, '127.0.0.1', settings.control_port)"),
])
