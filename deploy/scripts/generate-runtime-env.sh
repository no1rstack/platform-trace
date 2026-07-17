#!/usr/bin/env bash
# Generate runtime env for platform-trace deploy when Infisical project is ready.
# Also used as PRE_EXPORT_HOOK fallback: merges Infisical export with defaults.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
INFISICAL_DOMAIN="${INFISICAL_DOMAIN:-https://crypt.noirstack.com}"
INFISICAL_ENV="${INFISICAL_ENV:-prod}"
PROJECT_ID="${INFISICAL_PROJECT_ID:-18f8c337-f12b-470b-a4f7-bb88cf94c679}"
CASCADES_PROJECT_ID="${CASCADES_INFISICAL_PROJECT_ID:-329a278f-e9f2-4cff-b6f8-a32b74047819}"
KEYCLOAK_PROJECT_ID="${KEYCLOAK_INFISICAL_PROJECT_ID:-75ddc797-61e4-48c1-9d99-d307f83782ab}"
TOKEN_FILE="${ROOT}/deploy/vps/.platform-trace-token"
KC_SECRET_FILE="${ROOT}/deploy/vps/.platform-trace-keycloak-secret"
RUNTIME_FILE="${ROOT}/deploy/vps/runtime.env"

if [[ -z "${INFISICAL_TOKEN:-}" && -f /home/hira/scripts/.infisical-token ]]; then
  # shellcheck disable=SC1091
  source /home/hira/scripts/.infisical-token
fi

pick() {
  local key="$1" blob="$2"
  grep -E "^${key}=" <<<"$blob" 2>/dev/null | tail -1 | cut -d= -f2- | sed "s/^['\"]//;s/['\"]$//" || true
}

# Try new project first
BLOB=""
if [[ -n "${INFISICAL_TOKEN:-}" ]]; then
  BLOB="$(infisical export --projectId="$PROJECT_ID" --env="$INFISICAL_ENV" --domain="$INFISICAL_DOMAIN" --format=dotenv 2>/dev/null || true)"
fi

if [[ -n "$BLOB" && "$BLOB" != *"403 Forbidden"* && "$BLOB" != *"Unable to fetch"* ]]; then
  echo "$BLOB"
  exit 0
fi

# Fallback: build from local token file + defaults
if [[ ! -f "$TOKEN_FILE" ]]; then
  openssl rand -hex 32 > "$TOKEN_FILE"
  chmod 600 "$TOKEN_FILE"
fi
TRACE_TOKEN="$(cat "$TOKEN_FILE")"

COLLECTION_TOKEN=""
KC_BLOB=""
CASCADES_BLOB=""
if [[ -n "${INFISICAL_TOKEN:-}" ]]; then
  CASCADES_BLOB="$(infisical export --projectId="$CASCADES_PROJECT_ID" --env="$INFISICAL_ENV" --domain="$INFISICAL_DOMAIN" --format=dotenv 2>/dev/null || true)"
  COLLECTION_TOKEN="$(pick COLLECTION_INTERNAL_TOKEN "$CASCADES_BLOB")"
  KC_BLOB="$(infisical export --projectId="$KEYCLOAK_PROJECT_ID" --env="$INFISICAL_ENV" --domain="$INFISICAL_DOMAIN" --format=dotenv 2>/dev/null || true)"
fi

AUTH0_BASE="$(pick AUTH0_BASE_URL "$CASCADES_BLOB")"
AUTH0_CID="$(pick AUTH0_CLIENT_ID "$CASCADES_BLOB")"
AUTH0_CSEC="$(pick AUTH0_CLIENT_SECRET "$CASCADES_BLOB")"
AUTH0_DOM="$(pick AUTH0_DOMAIN "$CASCADES_BLOB")"
AUTH0_ISS="$(pick AUTH0_ISSUER_BASE_URL "$CASCADES_BLOB")"
AUTH0_AUD="$(pick AUTH0_AUDIENCE "$CASCADES_BLOB")"
AUTH0_SEC="$(pick AUTH0_SECRET "$CASCADES_BLOB")"

cat <<EOF
PORT=3040
HOST=0.0.0.0
NODE_ENV=production
PLATFORM_TRACE_DATA_DIR=/data
PLATFORM_PUBLIC_URL=https://trace.noirstack.com
PLATFORM_TRACE_TOKEN=${TRACE_TOKEN}
PLATFORM_TRACE_AUTH_REQUIRED=1
PLATFORM_TRACE_AUTH_PROVIDER=auth0
AUTH0_BASE_URL=https://trace.noirstack.com
AUTH0_CLIENT_ID=${AUTH0_CID}
AUTH0_CLIENT_SECRET=${AUTH0_CSEC}
AUTH0_DOMAIN=${AUTH0_DOM}
AUTH0_ISSUER_BASE_URL=${AUTH0_ISS}
AUTH0_AUDIENCE=${AUTH0_AUD}
AUTH0_SECRET=${AUTH0_SEC}
COLLECTOR_INTERVAL_MS=30000
COLLECTOR_CASCADES_ENABLED=true
COLLECTOR_CASCADES_URL=http://cascades:3000
COLLECTOR_CASCADES_LEGACY_ENABLED=true
COLLECTOR_PLATFORM_HEALTH_ENABLED=true
COLLECTOR_PLATFORM_HEALTH_URL=http://platform-api:3000
COLLECTOR_CASCADES_TOKEN=${COLLECTION_TOKEN}
EOF
