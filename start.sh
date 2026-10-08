#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 18 ou plus récent est requis : https://nodejs.org/"
  exit 1
fi

PORT="${PORT:-8765}"
echo "MeshLab RF est disponible sur http://localhost:${PORT}"
echo "Appuyez sur Ctrl+C pour arrêter."
PORT="$PORT" node server.js
