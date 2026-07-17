#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export INFISICAL_PROJECT_ID="${INFISICAL_PROJECT_ID:-18f8c337-f12b-470b-a4f7-bb88cf94c679}"
export COMPOSE_FILE="${COMPOSE_FILE:-$ROOT/deploy/compose.vps.yml}"
export COMPOSE_PROJECT="${COMPOSE_PROJECT:-platform-trace}"
export REQUIRED_VARS="PLATFORM_TRACE_TOKEN"
export PATH="${HOME}/.nvm/versions/node/v24.17.0/bin:${HOME}/.local/bin:/usr/bin:${PATH}"

export PRE_EXPORT_HOOK="bash '$ROOT/deploy/scripts/generate-runtime-env.sh'"

cd "$ROOT"
npm install
npm run build
podman build -f deploy/Dockerfile -t platform-trace:latest .

exec /home/hira/scripts/deploy.sh "$@"
