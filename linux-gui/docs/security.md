# Security model

## Protected assets

- Authenticated browser sessions and cookies.
- Files downloaded through authenticated sites.
- Workspace source code mounted into the desktop.
- CDP access, which can fully control an open browser profile.

## Boundaries

- Webtop HTTPS is bound to `127.0.0.1` only.
- CDP listens on container loopback and is not published by Compose.
- The Docker socket is not mounted.
- The container is not privileged and retains the Chrome sandbox.
- Docker's default seccomp filter is disabled for this service because it blocks the namespace operations required to initialize Chrome's own sandbox. The container remains unprivileged, receives no additional capabilities, and does not use `--no-sandbox`.
- Profiles, artifacts, downloads, runtime files, and `.env` are ignored by Git.
- Webtop's built-in Basic Auth is intentionally disabled; local access relies on the loopback-only port binding.
- Remote access requires the email-restricted Cloudflare Access policy. It is the only interactive authentication layer.

## Remote access

The supported remote entry point is `https://desktop.example.com`. It is routed through the existing Cloudflare Tunnel and guarded by an Access policy restricted to the authorized account. Tunnel ingress additionally validates the Access JWT before forwarding traffic.

The tunnel connects to Webtop's self-signed loopback HTTPS endpoint with origin-certificate verification disabled. This exception applies only to certificate verification on the local tunnel-to-origin hop; the public browser connection and Cloudflare Tunnel remain encrypted. Never publish the Webtop port on `0.0.0.0` or expose CDP through any tunnel.

Because Cloudflare Access is the sole interactive authentication layer, removing the Access application, weakening its policy, or disabling JWT validation would expose a desktop with no secondary password. Recheck the unauthenticated redirect and loopback binding after every tunnel or Access configuration change.

## Operational rules

- Perform first login in manual mode when an identity provider dislikes CDP.
- Close a profile before cloning it.
- Treat profile backups like credentials.
- Do not collect or print cookies, request authorization headers, passwords, or tokens.
- Rebuild the image to add software; do not rely on packages installed in a running container.

## Accepted seccomp exception

Runtime testing showed that Docker's built-in seccomp profile rejects Chrome's namespace setup with `Operation not permitted`. The project therefore uses `seccomp=unconfined` for this service. This increases the kernel syscall surface available after a container compromise. Risk is reduced by keeping the service on loopback, retaining Docker's dropped capabilities and AppArmor boundary, omitting the Docker socket, avoiding privileged mode, and preserving Chrome's internal renderer sandbox.
