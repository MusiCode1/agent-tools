# linux-gui

A persistent Linux desktop for manual GUI work and browser automation. It combines LinuxServer Webtop, Google Chrome, and Playwright CLI while keeping each browser identity in an explicit, non-standard `user-data-dir`.

Agent usage is documented in the project-local skill at `.agents/skills/linux-gui/SKILL.md`.

## Security warning

Anyone who can access this desktop can act as the accounts logged into its browser profiles. The GUI and Chrome DevTools Protocol are intentionally local-only. Remote browser access is protected by Cloudflare Access; CDP is never exposed. Webtop's built-in Basic Auth is intentionally disabled.

## Quick start

```bash
cp .env.example .env
# Adjust persistent paths if needed.
./scripts/linux-gui up --build
./scripts/linux-gui health
```

Open `https://127.0.0.1:6080/` and accept the local self-signed certificate. Local access has no Webtop password and remains limited to loopback.

## Remote access

Open [desktop.example.com](https://desktop.example.com). Cloudflare Access verifies the authorized account and is the only interactive authentication layer.

The remotely managed `home` Cloudflare Tunnel sends this hostname to the same loopback-only Webtop HTTPS endpoint. The origin route also requires a valid Access JWT. Do not add a public Docker port or expose a Chrome CDP port.

## Persistent locations

By default, persistent state lives outside the repository:

```text
~/.local/share/linux-gui/
├── config/
├── browser-profiles/
├── browser-projects/
└── downloads/
```

`/home/user/Projects` is mounted read-write at `/workspace`. Change `LINUX_GUI_WORKSPACE` if a narrower mount is preferred.

## Browser profiles

The Openbox shortcut `Google Chrome (CDP)` uses the fixed, non-default user-data directory `/data/browser-profiles/user`. It opens in CDP mode by default and records its selected loopback port under `/data/browser-projects/user/runtime/cdp-port`. Attach programmatically from the host with:

```bash
./scripts/linux-gui browser attach user
```

Create a profile and log in manually without remote debugging:

```bash
./scripts/linux-gui profile create moodle
./scripts/linux-gui browser open moodle --manual \
  --url https://moodle.example.edu/
```

After login, close Chrome cleanly and reopen the same profile for automation:

```bash
./scripts/linux-gui browser close moodle
./scripts/linux-gui browser open moodle --cdp \
  --url https://moodle.example.edu/
./scripts/linux-gui browser attach moodle
```

Some identity providers reject login while remote debugging is active. Always bootstrap those profiles in `--manual` mode, close them, and only then use `--cdp`.

Clone a cold profile for concurrent or disposable work:

```bash
./scripts/linux-gui profile clone moodle moodle-test
```

Never open one profile twice. Separate profiles may run concurrently.

## Moodle browser API

The logged-in Moodle interface exposes selected External functions through its session-authenticated AJAX endpoint. See [docs/moodle-ajax-api.md](docs/moodle-ajax-api.md) for the verified read call, its relationship to the official REST Web Service API, and the credential-handling rules.

## Resource limits

The container shares an 8 GB / 2-core host with a persistent backend and many
parallel agent processes, so `compose.yaml` caps it to keep it from starving the
host:

| Key | Value | Purpose |
| --- | --- | --- |
| `cpus` | `1.5` | CPU throttle only — rendering slows, the container is never killed. Leaves headroom for the backend. |
| `mem_limit` | `3g` | Hard memory ceiling. |
| `memswap_limit` | `5g` | Total (RAM + swap) → **2 GB swap headroom**. Under heavy load the browser degrades via swap instead of OOM-killing Chromium mid-verification. |
| `mem_reservation` | `1536m` | Soft target; reclaim pressure begins above it. |
| `pids_limit` | `512` | Process-count ceiling (idle desktop already runs ~300). |

Two things to keep in mind:

- **`shm_size` (2 GB) counts against `mem_limit`.** Chromium's `/dev/shm` usage is
  charged to the same memory cgroup, so `mem_limit` is deliberately well above it.
  If memory sticks high during heavy verification, drop `shm_size` to `1gb` to free
  budget rather than raising the ceiling.
- **Never set a tight hard `mem_limit` without swap headroom.** A ceiling that is too
  low OOM-kills the browser inside the container and loses the verification session;
  prefer a generous limit plus swap so it slows instead of dying.

Changing any of these requires recreating the container (`docker compose up -d`), not
just `docker restart` — a plain restart keeps the old host config.

## Management

```bash
./scripts/linux-gui status
./scripts/linux-gui logs
./scripts/linux-gui shell
./scripts/linux-gui down
```

Run `./tests/smoke.sh` after changes. The test creates isolated `smoke-*` profiles and removes only those profiles when finished.
