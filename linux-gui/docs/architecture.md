# Architecture

```text
Local browser ───────────── HTTPS/loopback ────────────┐
                                                       v
Remote browser ──> Cloudflare Access ──> Tunnel ──> LinuxServer Webtop
                                                       │
                                                       ├── XFCE desktop
                                                       ├── Google Chrome
                                                       └── Playwright CLI
                                                              │
                                      /data/browser-profiles/<name>
                                      /data/browser-projects/<name>/{runtime,artifacts}
```

The image extends `lscr.io/linuxserver/webtop:ubuntu-xfce`. Webtop owns the graphical session and persists its home directory at `/config`. A minimal Openbox session provides stable window management, with tint2 as a lightweight taskbar, Xfe as the file manager and the installed XFCE terminal. Chrome identities are deliberately separated from `/config` so they can be named, cloned, inspected, or retired independently.

Manual mode starts Chrome without remote debugging. CDP mode starts the same profile with a loopback-only debugging endpoint selected from ports 9222–9299. Playwright CLI runs inside the container and attaches to that endpoint, so CDP does not need a published Docker port.

`desktop.example.com` is an Access-protected hostname on the existing remotely managed Cloudflare Tunnel. Its ingress targets Webtop's loopback HTTPS listener and validates the Access JWT at the tunnel before forwarding to the origin.

The host scripts validate profile names before composing paths. Runtime metadata records the Chrome PID, mode, and CDP port. A profile with a live PID cannot be opened or cloned.
