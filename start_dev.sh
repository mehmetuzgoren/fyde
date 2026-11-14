#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "Applying Cloudflare D1 local migrations..."
(
  cd "$ROOT_DIR/edge"
  CI=1 ./node_modules/.bin/wrangler d1 migrations apply fyde-db --local
)

echo "Starting fyde. Cloudflare Edge Worker (D1 + R2 + Durable Objects) on http://127.0.0.1:8787 ..."
(
  cd "$ROOT_DIR/edge"
  CI=1 ./node_modules/.bin/wrangler dev --port 8787 --ip 127.0.0.1 --show-interactive-dev-session=false
) &
EDGE_PID=$!

cleanup() {
  echo "Stopping fyde. Cloudflare Edge Worker ($EDGE_PID)..."
  kill "$EDGE_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

echo "Starting fyde.izbirakin.com Web Experience (Waitlist + Login + Billing + 3-Tab App) on http://localhost:5173 ..."
cd "$ROOT_DIR/web"
if command -v bun >/dev/null 2>&1; then
  bun x vite --port 5173
else
  npx vite --port 5173
fi
