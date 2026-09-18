#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
ENV_FILE=${LINUX_GUI_ENV_FILE:-$PROJECT_ROOT/.env}

die() {
  echo "Error: $*" >&2
  exit 1
}

load_env() {
  [[ -f "$ENV_FILE" ]] || die "Missing $ENV_FILE; copy .env.example to .env"
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
  : "${LINUX_GUI_BROWSER_PROFILES:?Missing LINUX_GUI_BROWSER_PROFILES}"
  : "${LINUX_GUI_BROWSER_PROJECTS:?Missing LINUX_GUI_BROWSER_PROJECTS}"
}

validate_profile() {
  local name=${1:-}
  [[ "$name" =~ ^[A-Za-z0-9._-]+$ ]] || die "Invalid profile name: '$name'"
  [[ "$name" != "." && "$name" != ".." ]] || die "Invalid profile name: '$name'"
}

compose() {
  docker compose --project-directory "$PROJECT_ROOT" --env-file "$ENV_FILE" "$@"
}

container_is_running() {
  [[ "$(docker inspect -f '{{.State.Running}}' linux-gui 2>/dev/null || true)" == true ]]
}

require_container() {
  container_is_running || die "linux-gui container is not running"
}

profile_is_running() {
  local name=$1
  local pid_file="$LINUX_GUI_BROWSER_PROJECTS/$name/runtime/pid"
  [[ -f "$pid_file" ]] || return 1
  local pid
  pid=$(<"$pid_file")
  [[ "$pid" =~ ^[0-9]+$ ]] || return 1
  container_is_running || return 1
  docker exec linux-gui kill -0 "$pid" >/dev/null 2>&1
}
