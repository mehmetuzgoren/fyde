#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "Starting Fyde P2P Relay Server on http://127.0.0.1:8765 ..."
(
  cd "$ROOT_DIR/server"
  if [[ -f "$ROOT_DIR/.env" ]]; then
    uv run uvicorn app.main:app --env-file "$ROOT_DIR/.env" --host 127.0.0.1 --port 8765
  else
    uv run uvicorn app.main:app --host 127.0.0.1 --port 8765
  fi
) &
SERVER_PID=$!

cleanup() {
  echo "Stopping Fyde Relay Server ($SERVER_PID)..."
  kill "$SERVER_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

echo "Starting Fyde Web Companion on http://localhost:5173 ..."
cd "$ROOT_DIR/web"
if command -v bun >/dev/null 2>&1; then
  bun x vite --port 5173
else
  npx vite --port 5173
fi
