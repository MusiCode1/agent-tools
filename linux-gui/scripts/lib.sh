#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
ENV_FILE=${LINUX_GUI_ENV_FILE:-$PROJECT_ROOT/.env}

die() {
  echo "Error: $*" >&2
  exit 1
}

# Transport to the GUI container:
#   docker (default) — the container runs on this host; commands use `docker exec`.
#   ssh              — the container runs elsewhere (e.g. an Incus OCI container);
#                      commands run as the browser user over SSH to LINUX_GUI_SSH_HOST.
# In ssh mode no .env is required and profiles are addressed by their in-container
# paths, because the host-side profile directories are not on this machine.
is_ssh() { [[ "${LINUX_GUI_TRANSPORT:-docker}" == ssh ]]; }

load_env() {
  if [[ -f "$ENV_FILE" ]]; then
    set -a
    # shellcheck disable=SC1090
    source "$ENV_FILE"
    set +a
  elif ! is_ssh; then
    die "Missing $ENV_FILE; copy .env.example to .env"
  fi
  case "${LINUX_GUI_TRANSPORT:-docker}" in
    docker)
      : "${LINUX_GUI_BROWSER_PROFILES:?Missing LINUX_GUI_BROWSER_PROFILES}"
      : "${LINUX_GUI_BROWSER_PROJECTS:?Missing LINUX_GUI_BROWSER_PROJECTS}"
      ;;
    ssh) : "${LINUX_GUI_SSH_HOST:=gui}" ;;
    *) die "LINUX_GUI_TRANSPORT must be docker or ssh" ;;
  esac
}

# gui_exec [--root] [--tty] [--workdir DIR] CMD [ARGS...]
# Runs CMD in the GUI container as the browser user (abc). --root applies to
# docker only; over SSH only the browser user can log in.
gui_exec() {
  local user=abc workdir="" tty=""
  while (($#)); do
    case "$1" in
      --root) user="" ;;
      --tty) tty=1 ;;
      --workdir) workdir=$2; shift ;;
      *) break ;;
    esac
    shift
  done
  if is_ssh; then
    local remote
    remote="exec $(printf '%q ' "$@")"
    [[ -n "$workdir" ]] && remote="cd $(printf '%q' "$workdir") && $remote"
    ssh -o BatchMode=yes ${tty:+-t} "$LINUX_GUI_SSH_HOST" "$remote"
  else
    docker exec ${tty:+-it} ${user:+--user "$user"} ${workdir:+--workdir "$workdir"} linux-gui "$@"
  fi
}

profile_exists() {
  if is_ssh; then
    gui_exec test -d "/data/browser-profiles/$1"
  else
    [[ -d "$LINUX_GUI_BROWSER_PROFILES/$1" ]]
  fi
}

# Prints the recorded CDP port of a running profile, or nothing.
profile_cdp_port() {
  if is_ssh; then
    gui_exec cat "/data/browser-projects/$1/runtime/cdp-port" 2>/dev/null || true
  else
    local f="$LINUX_GUI_BROWSER_PROJECTS/$1/runtime/cdp-port"
    [[ -f "$f" ]] && cat "$f" || true
  fi
}

validate_profile() {
  local name=${1:-}
  [[ "$name" =~ ^[A-Za-z0-9._-]+$ ]] || die "Invalid profile name: '$name'"
  [[ "$name" != "." && "$name" != ".." ]] || die "Invalid profile name: '$name'"
}

compose() {
  is_ssh && die "The container lifecycle is managed on its own host (LINUX_GUI_TRANSPORT=ssh)"
  docker compose --project-directory "$PROJECT_ROOT" --env-file "$ENV_FILE" "$@"
}

container_is_running() {
  if is_ssh; then
    ssh -o BatchMode=yes -o ConnectTimeout=5 "$LINUX_GUI_SSH_HOST" true >/dev/null 2>&1
  else
    [[ "$(docker inspect -f '{{.State.Running}}' linux-gui 2>/dev/null || true)" == true ]]
  fi
}

require_container() {
  container_is_running || die "linux-gui container is not running"
}

profile_is_running() {
  local name=$1
  if is_ssh; then
    # shellcheck disable=SC2016
    gui_exec bash -c 'p=$(cat "$1" 2>/dev/null) && [[ "$p" =~ ^[0-9]+$ ]] && kill -0 "$p"' _ \
      "/data/browser-projects/$name/runtime/pid" >/dev/null 2>&1
    return
  fi
  local pid_file="$LINUX_GUI_BROWSER_PROJECTS/$name/runtime/pid"
  [[ -f "$pid_file" ]] || return 1
  local pid
  pid=$(<"$pid_file")
  [[ "$pid" =~ ^[0-9]+$ ]] || return 1
  container_is_running || return 1
  docker exec linux-gui kill -0 "$pid" >/dev/null 2>&1
}
