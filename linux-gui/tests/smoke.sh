#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/../scripts/lib.sh"
load_env

name="smoke-$(date +%s)"
clone_name="$name-clone"
profile_dir="$LINUX_GUI_BROWSER_PROFILES/$name"
clone_dir="$LINUX_GUI_BROWSER_PROFILES/$clone_name"
project_dir="$LINUX_GUI_BROWSER_PROJECTS/$name"
clone_project_dir="$LINUX_GUI_BROWSER_PROJECTS/$clone_name"

cleanup() {
  if container_is_running; then
    docker exec --user abc linux-gui linux-gui-browser-close "$name" >/dev/null 2>&1 || true
    docker exec --user abc linux-gui linux-gui-browser-close "$clone_name" >/dev/null 2>&1 || true
  fi
  [[ "$name" == smoke-* ]] && rm -rf -- "$profile_dir" "$project_dir"
  [[ "$clone_name" == smoke-*-clone ]] && rm -rf -- "$clone_dir" "$clone_project_dir"
}
trap cleanup EXIT

compose config >/dev/null

if "$PROJECT_ROOT/scripts/profile-create" ../escape >/dev/null 2>&1; then
  die "Path traversal profile was accepted"
fi

"$PROJECT_ROOT/scripts/profile-create" "$name"
[[ -d "$profile_dir" ]]
if "$PROJECT_ROOT/scripts/profile-create" "$name" >/dev/null 2>&1; then
  die "Duplicate profile was accepted"
fi

if ! container_is_running; then
  echo "Compose and profile validation passed; runtime checks skipped because linux-gui is stopped"
  exit 0
fi

"$PROJECT_ROOT/scripts/healthcheck"
"$PROJECT_ROOT/scripts/browser-open" "$name" --manual --url about:blank
profile_is_running "$name"
if "$PROJECT_ROOT/scripts/browser-open" "$name" --manual >/dev/null 2>&1; then
  die "A profile was opened twice"
fi
"$PROJECT_ROOT/scripts/browser-close" "$name"
! profile_is_running "$name"

"$PROJECT_ROOT/scripts/profile-clone" "$name" "$clone_name"
[[ -d "$clone_dir" ]]
if "$PROJECT_ROOT/scripts/profile-clone" "$name" "$clone_name" >/dev/null 2>&1; then
  die "Clone overwrote an existing target"
fi

"$PROJECT_ROOT/scripts/browser-open" "$name" --cdp --url about:blank
port=$(<"$LINUX_GUI_BROWSER_PROJECTS/$name/runtime/cdp-port")
for _ in $(seq 1 20); do
  docker exec linux-gui curl -fsS "http://127.0.0.1:$port/json/version" >/dev/null 2>&1 && break
  sleep 0.5
done
docker exec linux-gui curl -fsS "http://127.0.0.1:$port/json/version" >/dev/null
"$PROJECT_ROOT/scripts/browser-attach" "$name"
docker exec --user abc --workdir "/data/browser-projects/$name" linux-gui \
  playwright-cli screenshot --filename=artifacts/example.png >/dev/null
docker exec --user abc --workdir "/data/browser-projects/$name" linux-gui \
  playwright-cli detach >/dev/null
[[ -s "$project_dir/artifacts/example.png" ]]
"$PROJECT_ROOT/scripts/browser-close" "$name"

echo "Smoke tests passed"
