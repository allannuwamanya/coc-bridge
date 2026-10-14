#!/usr/bin/env bash
# Runner for OpenCode-Claude Bridge Proxy
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export NODE_BIN="${NODE_BIN:-/home/alan/.nvm/versions/node/v24.21.0/bin/node}"
export BRIDGE_PORT="${BRIDGE_PORT:-4045}"
export OPENCODE_MODEL="${OPENCODE_MODEL:-opencode/space-bunny-free}"

echo "Starting OpenCode-Claude Bridge on port $BRIDGE_PORT..."
exec "$NODE_BIN" "$SCRIPT_DIR/server.js"
