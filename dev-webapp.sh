#!/bin/bash
# Run jambonz-webapp in dev (Vite). API must be up on port 3000 (Docker or PM2).
set -e
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT/jambonz-webapp"
if [ ! -d node_modules ]; then
  echo "Installing webapp dependencies..."
  npm install
fi
export VITE_API_BASE_URL="${VITE_API_BASE_URL:-http://127.0.0.1:3000/v1}"
export VITE_DEV_BASE_URL="${VITE_DEV_BASE_URL:-http://127.0.0.1:3000/v1}"
echo "Webapp dev → http://localhost:3001  (API → $VITE_API_BASE_URL)"
npm run dev
