#!/bin/bash
# Start quill-mcp in HTTP mode for remote access.
#
# Usage:
#   ./start-http.sh                     # Default: port 3000, localhost only
#   ./start-http.sh --port 8080         # Custom port
#   ./start-http.sh --host 0.0.0.0      # Bind to all interfaces (use with auth)
#   ./start-http.sh --auth-token SECRET # Require Bearer token auth
#
# Environment variables:
#   QUILL_HTTP_ENABLED=true   Enable HTTP mode
#   QUILL_HTTP_PORT=3000      HTTP port
#   QUILL_HTTP_HOST=127.0.0.1 Bind address
#   QUILL_AUTH_TOKEN=secret   Bearer token for authentication
#   NOTES_VAULT_PATH=/path    Vault path override

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

export QUILL_HTTP_ENABLED=true

echo "Starting quill-mcp in HTTP mode..."
echo "  Stdio transport: active (for local MCP clients)"
echo "  HTTP transport:  active on ${QUILL_HTTP_HOST:-127.0.0.1}:${QUILL_HTTP_PORT:-3000}"

if [ -n "${QUILL_AUTH_TOKEN:-}" ]; then
    echo "  Authentication:  enabled (Bearer token)"
else
    echo "  Authentication:  disabled (set QUILL_AUTH_TOKEN to enable)"
fi

exec node "$SCRIPT_DIR/dist/index.js" "$@"
