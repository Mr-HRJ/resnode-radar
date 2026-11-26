#!/usr/bin/env bash
# < 60s safe rollback helper for VPS雷达 v2 -> v1 on Ubuntu VPS.
# Usage: sudo ./deploy/vps/rollback.sh /opt/resnode-radar/releases/<prev-v1-release>
set -euo pipefail

PREV_RELEASE="${1:-}"
if [[ -z "$PREV_RELEASE" || ! -d "$PREV_RELEASE" ]]; then
  echo "Usage: $0 /opt/resnode-radar/releases/<prev-v1-release>" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
SCRIPT_REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd -P)"

NODE_BIN="${NODE_BIN:-/opt/resnode-radar/node/bin/node}"
SHARED_DATA="${SHARED_DATA:-/var/lib/resnode-radar/data}"
CURRENT_LINK="${CURRENT_LINK:-/opt/resnode-radar/current}"
RUN_AS_USER="${RUN_AS_USER-resnode-radar}"
SYSTEMCTL_BIN="${SYSTEMCTL_BIN:-systemctl}"
NGINX_BIN="${NGINX_BIN:-nginx}"

run_as_collector() {
  if [[ -n "$RUN_AS_USER" && "$(id -un)" != "$RUN_AS_USER" ]]; then
    sudo -u "$RUN_AS_USER" "$@"
  else
    "$@"
  fi
}

# Complete all path, script, and permission preflights BEFORE stopping resnode-radar!
if [[ ! -x "$NODE_BIN" ]]; then
  echo "Error: Node executable not found at $NODE_BIN" >&2
  exit 1
fi
REAL_PREV_RELEASE="$(cd "$PREV_RELEASE" && pwd -P)"
if [[ ! -d "$SHARED_DATA" ]]; then
  echo "Error: Persistent shared data directory not found at $SHARED_DATA" >&2
  exit 1
fi
REAL_SHARED_DATA="$(cd "$SHARED_DATA" && pwd -P)"
if [[ ! -f "$REAL_SHARED_DATA/products.json" ]]; then
  echo "Error: Missing persistent $REAL_SHARED_DATA/products.json" >&2
  exit 1
fi
if ! run_as_collector test -w "$REAL_SHARED_DATA"; then
  echo "Error: Collector user cannot write to $REAL_SHARED_DATA" >&2
  exit 1
fi
if [[ -e "$CURRENT_LINK" && ! -L "$CURRENT_LINK" ]]; then
  echo "Error: $CURRENT_LINK exists and is not a symlink; refusing to overwrite" >&2
  exit 1
fi

# Validate Nginx configuration BEFORE stopping services or switching symlinks
"$NGINX_BIN" -t

# Pin fallback pointer tool strictly to THIS v2 release (never $CURRENT_LINK, which already points to v1 on retry!)
FALLBACK_SCRIPT="$SCRIPT_REPO_ROOT/scripts/monitor.mjs"
FALLBACK_RUNNER="$SCRIPT_REPO_ROOT/apps/collector/src/runner.js"
if [[ ! -f "$FALLBACK_SCRIPT" || ! -f "$FALLBACK_RUNNER" ]] || ! grep -q -- '--v1-fallback' "$FALLBACK_RUNNER"; then
  echo "Error: $SCRIPT_REPO_ROOT does not contain a v2 collector supporting --v1-fallback" >&2
  exit 1
fi
if ! "$NODE_BIN" "$FALLBACK_SCRIPT" --check-v1-fallback-support >/dev/null 2>&1; then
  echo "Error: $FALLBACK_SCRIPT failed --check-v1-fallback-support preflight" >&2
  exit 1
fi

# Ensure target release's data path points cleanly to REAL_SHARED_DATA before stopping services
if [[ "$REAL_PREV_RELEASE/data" != "$REAL_SHARED_DATA" ]]; then
  if [[ -L "$REAL_PREV_RELEASE/data" ]]; then
    rm -f "$REAL_PREV_RELEASE/data"
  elif [[ -d "$REAL_PREV_RELEASE/data" ]]; then
    rm -rf "$REAL_PREV_RELEASE/data"
  fi
  ln -s "$REAL_SHARED_DATA" "$REAL_PREV_RELEASE/data"
fi
RESOLVED_PREV_DATA="$(cd "$REAL_PREV_RELEASE/data" && pwd -P)"
if [[ ! -L "$REAL_PREV_RELEASE/data" || "$RESOLVED_PREV_DATA" != "$REAL_SHARED_DATA" ]]; then
  echo "Error: $REAL_PREV_RELEASE/data failed symlink verification" >&2
  exit 1
fi

COLLECTOR_STOPPED=0
cleanup_on_error() {
  local exit_code=$?
  if [[ "$COLLECTOR_STOPPED" -eq 1 ]]; then
    echo "Warning: Rollback failed after stopping resnode-radar; attempting service recovery..." >&2
    "$SYSTEMCTL_BIN" start resnode-radar || true
  fi
  exit "$exit_code"
}
trap cleanup_on_error ERR

echo "[1/3] Stopping collector daemon and writing atomic v1-fallback pointer..."
"$SYSTEMCTL_BIN" stop resnode-radar
COLLECTOR_STOPPED=1

(
  cd "$REAL_PREV_RELEASE"
  run_as_collector env MONITOR_DATA_DIR="$REAL_SHARED_DATA" "$NODE_BIN" "$FALLBACK_SCRIPT" --v1-fallback
)
if [[ ! -f "$REAL_SHARED_DATA/v2/latest.json" ]]; then
  echo "Error: Failed to write $REAL_SHARED_DATA/v2/latest.json" >&2
  exit 1
fi

echo "[2/3] Switching $CURRENT_LINK back to $REAL_PREV_RELEASE..."
mkdir -p "$(dirname "$CURRENT_LINK")"
ln -sfn "$REAL_PREV_RELEASE" "$CURRENT_LINK"
"$SYSTEMCTL_BIN" restart resnode-radar-stats
"$SYSTEMCTL_BIN" start resnode-radar
COLLECTOR_STOPPED=0

echo "[3/3] Verifying and reloading Nginx..."
"$NGINX_BIN" -t
"$SYSTEMCTL_BIN" reload nginx
echo "Rollback complete. Open v2 browser tabs will auto-switch to data/products.json."
