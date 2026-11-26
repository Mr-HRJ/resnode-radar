#!/usr/bin/env bash
# Zero-downtime cutover helper for VPS雷达 v2 architecture on Ubuntu VPS.
# Usage: sudo ./deploy/vps/cutover.sh /opt/resnode-radar/releases/<new-release>
set -euo pipefail

NEW_RELEASE="${1:-}"
if [[ -z "$NEW_RELEASE" || ! -d "$NEW_RELEASE" ]]; then
  echo "Usage: $0 /opt/resnode-radar/releases/<new-release>" >&2
  exit 1
fi

NODE_BIN="${NODE_BIN:-/opt/resnode-radar/node/bin/node}"
SHARED_DATA="${SHARED_DATA:-/var/lib/resnode-radar/data}"
SHARED_STATIC="${SHARED_STATIC:-/var/lib/resnode-radar/static}"
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

# Preflight binary, build artifacts, and persistent shared data BEFORE touching symlinks or services
if [[ ! -x "$NODE_BIN" ]]; then
  echo "Error: Node executable not found at $NODE_BIN" >&2
  exit 1
fi
REAL_NEW_RELEASE="$(cd "$NEW_RELEASE" && pwd -P)"
if [[ ! -f "$REAL_NEW_RELEASE/scripts/monitor.mjs" ]]; then
  echo "Error: Missing $REAL_NEW_RELEASE/scripts/monitor.mjs" >&2
  exit 1
fi
if [[ ! -d "$REAL_NEW_RELEASE/dist/static" ]]; then
  echo "Error: Missing built browser assets at $REAL_NEW_RELEASE/dist/static (run npm run build:vps first)" >&2
  exit 1
fi
if [[ -e "$CURRENT_LINK" && ! -L "$CURRENT_LINK" ]]; then
  echo "Error: $CURRENT_LINK exists and is not a symlink; refusing to overwrite" >&2
  exit 1
fi
if [[ -L "$SHARED_DATA" && ! -d "$SHARED_DATA" ]]; then
  echo "Error: $SHARED_DATA is a broken symlink" >&2
  exit 1
fi
mkdir -p "$SHARED_DATA"
REAL_SHARED_DATA="$(cd "$SHARED_DATA" && pwd -P)"

if [[ "$REAL_NEW_RELEASE" == "$REAL_SHARED_DATA" || "$REAL_NEW_RELEASE/data" == "$REAL_SHARED_DATA" ]]; then
  echo "Error: Release path ($REAL_NEW_RELEASE) collides with shared data path ($REAL_SHARED_DATA)" >&2
  exit 1
fi

# Bootstrap initial baseline files only if shared data has no products.json yet (never overwrite persistent data)
if [[ ! -f "$REAL_SHARED_DATA/products.json" && -f "$REAL_NEW_RELEASE/data/products.json" ]]; then
  cp -n "$REAL_NEW_RELEASE/data/products.json" "$REAL_SHARED_DATA/products.json"
  if [[ -f "$REAL_NEW_RELEASE/data/fx.json" ]]; then
    cp -n "$REAL_NEW_RELEASE/data/fx.json" "$REAL_SHARED_DATA/fx.json"
  fi
fi
if [[ ! -f "$REAL_SHARED_DATA/products.json" ]]; then
  echo "Error: Missing persistent baseline $REAL_SHARED_DATA/products.json" >&2
  exit 1
fi
if ! run_as_collector test -w "$REAL_SHARED_DATA"; then
  echo "Error: Collector user cannot write to $REAL_SHARED_DATA" >&2
  exit 1
fi

# Validate Nginx config BEFORE stopping services or modifying release symlinks
"$NGINX_BIN" -t

wait_for_collector_exit() {
  local deadline=$((SECONDS + 35))
  local active_state=""
  while (( SECONDS < deadline )); do
    active_state="$("$SYSTEMCTL_BIN" show -p ActiveState --value resnode-radar 2>/dev/null || true)"
    case "$active_state" in
      active|deactivating|reloading|activating)
        sleep 0.2
        ;;
      *)
        return 0
        ;;
    esac
  done
  echo "Error: Collector service resnode-radar did not exit cleanly after stop (state=$active_state)" >&2
  return 1
}

COLLECTOR_STOPPED=0
cleanup_on_error() {
  local exit_code=$?
  if [[ "$exit_code" -ne 0 && "$COLLECTOR_STOPPED" -eq 1 ]]; then
    echo "Warning: Cutover failed after stopping resnode-radar; attempting service recovery..." >&2
    "$SYSTEMCTL_BIN" start resnode-radar || true
  fi
  exit "$exit_code"
}
trap cleanup_on_error EXIT

echo "[1/6] Linking persistent data directory..."
if [[ -L "$REAL_NEW_RELEASE/data" ]]; then
  rm -f "$REAL_NEW_RELEASE/data"
elif [[ -d "$REAL_NEW_RELEASE/data" ]]; then
  rm -rf "$REAL_NEW_RELEASE/data"
elif [[ -e "$REAL_NEW_RELEASE/data" ]]; then
  echo "Error: Unexpected non-directory file at $REAL_NEW_RELEASE/data" >&2
  exit 1
fi
ln -s "$REAL_SHARED_DATA" "$REAL_NEW_RELEASE/data"

RESOLVED_RELEASE_DATA="$(cd "$REAL_NEW_RELEASE/data" && pwd -P)"
if [[ ! -L "$REAL_NEW_RELEASE/data" || "$RESOLVED_RELEASE_DATA" != "$REAL_SHARED_DATA" || -L "$REAL_SHARED_DATA/data" ]]; then
  echo "Error: $REAL_NEW_RELEASE/data failed symlink verification (resolved: $RESOLVED_RELEASE_DATA)" >&2
  exit 1
fi

echo "[2/6] Publishing immutable browser assets to $SHARED_STATIC..."
mkdir -p "$SHARED_STATIC"
cp -a "$REAL_NEW_RELEASE/dist/static/." "$SHARED_STATIC/"

echo "[3/6] Stopping legacy collector service and waiting for exit before v2 seed..."
"$SYSTEMCTL_BIN" stop resnode-radar
COLLECTOR_STOPPED=1
wait_for_collector_exit

echo "[4/6] Seeding initial v2 snapshot from persistent products.json (single-writer locked)..."
(
  cd "$REAL_NEW_RELEASE"
  run_as_collector env MONITOR_DATA_DIR="$REAL_SHARED_DATA" "$NODE_BIN" "$REAL_NEW_RELEASE/scripts/monitor.mjs" --seed-v2-from-v1
)
if [[ ! -f "$REAL_SHARED_DATA/v2/latest.json" ]]; then
  echo "Error: v2 pointer was not created at $REAL_SHARED_DATA/v2/latest.json" >&2
  exit 1
fi

echo "[5/6] Switching $CURRENT_LINK symlink and starting services..."
mkdir -p "$(dirname "$CURRENT_LINK")"
ln -sfn "$REAL_NEW_RELEASE" "$CURRENT_LINK"
"$SYSTEMCTL_BIN" restart resnode-radar-stats
"$SYSTEMCTL_BIN" start resnode-radar
COLLECTOR_STOPPED=0

echo "[6/6] Verifying and reloading Nginx configuration..."
"$NGINX_BIN" -t
"$SYSTEMCTL_BIN" reload nginx
echo "Cutover complete."
