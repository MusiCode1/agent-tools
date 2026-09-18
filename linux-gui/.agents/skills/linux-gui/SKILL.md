---
name: linux-gui
description: Operate and troubleshoot this project's persistent Webtop Linux desktop, named Chrome profiles, manual login sessions, CDP attachment, and Playwright automation. Use when a task mentions the linux-gui container, Web Desktop, desktop.example.com, the persistent GUI browser, browser profiles, CDP, or running GUI applications in this environment.
---

# Linux GUI

Operate the persistent GUI through the repository scripts. Preserve browser identities and keep the desktop and CDP loopback-only.

## Start safely

1. Work from the repository root.
2. Read `AGENTS.md` before changing files.
3. Run `./scripts/linux-gui status` and `./scripts/linux-gui health` before diagnosing a live task.
4. Use `./scripts/linux-gui up --build` only when the service must be created or rebuilt.
5. Open `https://desktop.example.com` for the remote desktop. Expect Cloudflare Access authentication; Webtop Basic Auth is intentionally disabled.

Never print `.env`, authentication headers, cookies, passwords, tokens, or browser storage values.

## Choose a browser workflow

Use the fixed `user` profile when the user refers to the browser shortcut or their existing logged-in browser:

```bash
./scripts/linux-gui browser open user --cdp --url about:blank
./scripts/linux-gui browser attach user
```

The Openbox shortcut `Google Chrome (CDP)` already opens this profile with a free loopback CDP port. If it is open, attach instead of launching it again. The launcher rejects duplicate use of a profile.

For a new identity or a login flow that rejects remote debugging:

```bash
./scripts/linux-gui profile create <name>
./scripts/linux-gui browser open <name> --manual --url <login-url>
```

Let the user complete login in the GUI. Then close and reopen the same profile in CDP mode:

```bash
./scripts/linux-gui browser close <name>
./scripts/linux-gui browser open <name> --cdp --url <target-url>
./scripts/linux-gui browser attach <name>
```

Clone only a cold profile:

```bash
./scripts/linux-gui profile clone <source> <target>
```

Never clone or copy a running profile.

## Automate the visible browser

Before issuing Playwright commands, load and follow both the `playwright-cli` and `linux-gui-browser` skills, including the bundled `@playwright/cli` instructions required by those skills.

After `browser attach`, run Playwright inside the container and the profile's project directory:

```bash
docker exec --user abc --workdir /data/browser-projects/<name> linux-gui \
  playwright-cli snapshot
```

Prefer accessibility snapshots and element refs. Use screenshots only when visual inspection is necessary. Detach when finished so Chrome remains open:

```bash
docker exec --user abc --workdir /data/browser-projects/<name> linux-gui \
  playwright-cli detach
```

Keep session credentials inside the browser context. It is acceptable to report whether a credential exists or whether an authenticated read succeeded; never return the credential value.

## Persistent paths

Treat these as user data, not repository content:

```text
~/.local/share/linux-gui/config
~/.local/share/linux-gui/browser-profiles
~/.local/share/linux-gui/browser-projects
~/.local/share/linux-gui/downloads
```

Do not commit, bulk-delete, or overwrite these directories. Store temporary automation artifacts under the relevant `/data/browser-projects/<name>/artifacts` directory and remove task-specific diagnostics when finished.

## Diagnose

Use the narrowest relevant command:

```bash
./scripts/linux-gui status
./scripts/linux-gui health
./scripts/linux-gui logs
./scripts/linux-gui shell
```

Run `./tests/smoke.sh` after implementation changes. The smoke test creates and removes only isolated `smoke-*` profiles.

Do not add `--no-sandbox`, privileged mode, capabilities, a Docker socket mount, public CDP ports, or public Webtop ports. `seccomp=unconfined` is the project's explicitly accepted exception; Chrome's internal sandbox must remain enabled.

Cloudflare Access is the only interactive authentication layer. Before changing authentication, tunnel ingress, DNS, or port bindings, verify that an unauthenticated public request redirects to Cloudflare Access and that Docker publishes Webtop only on `127.0.0.1`.

## Container runtime support

Treat Docker Compose as the supported runtime. The image and most Compose fields are likely portable to Podman, but the repository is not currently runtime-neutral: host scripts and tests call `docker`, `docker compose`, `docker inspect`, and `docker exec` directly.

Do not claim Podman support until the runtime command is abstracted, rootless bind-mount ownership is handled, Chrome sandbox behavior is verified, and the full smoke test passes under the selected Podman Compose provider.
