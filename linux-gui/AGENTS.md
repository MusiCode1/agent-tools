# Agent guidance

This repository builds a persistent, local-only Linux GUI for manual and automated browser work.

## Required workflows

- Load the project-local `linux-gui` skill before operating or troubleshooting the live GUI environment.
- Follow the `dev-conventions` skill before structural changes.
- Follow `update-walkthrough` before editing `docs/walkthrough.md`.
- Follow `commit` before any commit. Never commit without explicit user approval.
- Read the `playwright-cli` and `linux-gui-browser` skills before changing browser automation.

## Commands

- Validate Compose: `docker compose --env-file .env config`
- Build: `docker compose --env-file .env build`
- Start: `./scripts/linux-gui up`
- Health: `./scripts/linux-gui health`
- Test: `./tests/smoke.sh`

## Security boundaries

- Keep the web desktop and CDP on loopback.
- Never mount the Docker socket or use privileged mode.
- `seccomp=unconfined` is an explicitly accepted exception required by Chrome sandbox initialization. Do not add capabilities or `--no-sandbox` around it.
- Never add `--no-sandbox` to Chrome.
- Never log cookies, authorization headers, passwords, or tokens.
- Never commit `.env`, profiles, runtime data, downloads, or artifacts.
- Do not change or remove unrelated containers.

## Layout

- `compose.yaml` and `Dockerfile`: container definition.
- `config/chromium/`: files installed into the image.
- `scripts/`: host-side lifecycle and profile commands.
- `tests/smoke.sh`: behavioral smoke checks.
- `docs/`: architecture, security, and execution log.
