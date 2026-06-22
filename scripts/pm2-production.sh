#!/usr/bin/env bash
# Clean PM2 production deploy — avoids port 3000 EADDRINUSE from orphan node processes.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

PORT="${PORT:-3000}"

echo "[pm2-production] Stopping PM2 apps…"
pm2 stop ecosystem.config.cjs 2>/dev/null || true

echo "[pm2-production] Freeing port ${PORT} if held by orphan node…"
if command -v fuser >/dev/null 2>&1; then
  fuser -k "${PORT}/tcp" 2>/dev/null || true
elif command -v lsof >/dev/null 2>&1; then
  PIDS="$(lsof -ti ":${PORT}" 2>/dev/null || true)"
  if [ -n "${PIDS}" ]; then
    echo "[pm2-production] Killing PIDs on :${PORT}: ${PIDS}"
    kill ${PIDS} 2>/dev/null || true
    sleep 1
  fi
fi

echo "[pm2-production] Starting ecosystem (with --update-env)…"
pm2 startOrRestart ecosystem.config.cjs --update-env
pm2 save

echo "[pm2-production] Status:"
pm2 list
