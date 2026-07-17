#!/usr/bin/env bash
# Populate platform-trace Infisical project (prod).
# Project: 18f8c337-f12b-470b-a4f7-bb88cf94c679 @ crypt.noirstack.com
#
# Prerequisite: assign the deploy machine identity to this project in Infisical UI.
#
# Usage:
#   ./deploy/scripts/bootstrap-infisical-secrets.sh
#   ./deploy/scripts/bootstrap-infisical-secrets.sh --dry-run
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PROJECT_ID="${INFISICAL_PROJECT_ID:-18f8c337-f12b-470b-a4f7-bb88cf94c679}"
CASCADES_PROJECT_ID="${CASCADES_INFISICAL_PROJECT_ID:-329a278f-e9f2-4cff-b6f8-a32b74047819}"
JUDICIUM_PROJECT_ID="${JUDICIUM_INFISICAL_PROJECT_ID:-5b45a8a0-eb6d-4791-8dd3-705978da44d0}"
OLD_PLATFORM_API_PROJECT="${OLD_PLATFORM_API_PROJECT_ID:-75ddc797-61e4-48c1-9d99-d307f83782ab}"
INFISICAL_DOMAIN="${INFISICAL_DOMAIN:-https://crypt.noirstack.com}"
INFISICAL_ENV="${INFISICAL_ENV:-prod}"
DRY_RUN=0

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
  esac
done

if [[ -z "${INFISICAL_TOKEN:-}" && -f /home/hira/scripts/.infisical-token ]]; then
  # shellcheck disable=SC1091
  source /home/hira/scripts/.infisical-token
fi
export PATH="${HOME}/.local/bin:${PATH}"

TOKEN_FILE="${ROOT}/deploy/vps/.platform-trace-token"
KC_SECRET_FILE="${ROOT}/deploy/vps/.platform-trace-keycloak-secret"
if [[ ! -f "$TOKEN_FILE" ]]; then
  openssl rand -hex 32 > "$TOKEN_FILE"
  chmod 600 "$TOKEN_FILE"
fi
TRACE_TOKEN="$(cat "$TOKEN_FILE")"

if [[ ! -f "$KC_SECRET_FILE" ]]; then
  openssl rand -base64 32 | tr -d '/+=' | head -c 32 > "$KC_SECRET_FILE"
  chmod 600 "$KC_SECRET_FILE"
fi
KC_SECRET="$(cat "$KC_SECRET_FILE")"

KC_BLOB="$(infisical export --projectId="$OLD_PLATFORM_API_PROJECT" --env="$INFISICAL_ENV" --domain="$INFISICAL_DOMAIN" --format=dotenv 2>/dev/null || true)"
KC_BASE="$(grep -E '^KEYCLOAK_BASE_URL=' <<<"$KC_BLOB" | tail -1 | cut -d= -f2- | sed "s/^['\"]//;s/['\"]$//")"

set_secret() {
  local key="$1" val="$2"
  if [[ "$DRY_RUN" == 1 ]]; then
    echo "  [dry-run] $key=***"
    return
  fi
  infisical secrets set "$key=$val" \
    --projectId="$PROJECT_ID" --env="$INFISICAL_ENV" --domain="$INFISICAL_DOMAIN" \
    ${INFISICAL_TOKEN:+--token="$INFISICAL_TOKEN"}
}

echo "=== platform-trace Infisical bootstrap ==="
echo "project: $PROJECT_ID ($INFISICAL_ENV)"

set_secret PORT 3040
set_secret HOST 0.0.0.0
set_secret NODE_ENV production
set_secret PLATFORM_TRACE_DATA_DIR /data
set_secret PLATFORM_PUBLIC_URL https://trace.noirstack.com
set_secret PLATFORM_TRACE_TOKEN "$TRACE_TOKEN"
set_secret PLATFORM_TRACE_AUTH_REQUIRED 1
set_secret PLATFORM_TRACE_AUTH_PROVIDER auth0

# Auth0 — shared tenant/client with per-app callback URLs (same pattern as Cascades/Judicium)
CASCADES_BLOB="$(infisical export --projectId="$CASCADES_PROJECT_ID" --env="$INFISICAL_ENV" --domain="$INFISICAL_DOMAIN" --format=dotenv 2>/dev/null || true)"
pick_cascades() { grep -E "^${1}=" <<<"$CASCADES_BLOB" 2>/dev/null | tail -1 | cut -d= -f2- | sed "s/^['\"]//;s/['\"]$//" || true; }

set_secret AUTH0_BASE_URL https://trace.noirstack.com
set_secret AUTH0_CLIENT_ID "$(pick_cascades AUTH0_CLIENT_ID)"
set_secret AUTH0_CLIENT_SECRET "$(pick_cascades AUTH0_CLIENT_SECRET)"
set_secret AUTH0_DOMAIN "$(pick_cascades AUTH0_DOMAIN)"
set_secret AUTH0_ISSUER_BASE_URL "$(pick_cascades AUTH0_ISSUER_BASE_URL)"
set_secret AUTH0_AUDIENCE "$(pick_cascades AUTH0_AUDIENCE)"
set_secret AUTH0_SECRET "$(pick_cascades AUTH0_SECRET)"

set_secret PLATFORM_TRACE_COOKIE_SECURE 1
set_secret PLATFORM_TRACE_REQUIRED_ROLES trace.noirstack.com
set_secret KEYCLOAK_BASE_URL "${KC_BASE:-https://auth.noirstack.com}"
set_secret KEYCLOAK_REALM gateway
set_secret KEYCLOAK_CLIENT_ID platform-trace-noirstack
set_secret KEYCLOAK_CLIENT_SECRET "$KC_SECRET"
set_secret KEYCLOAK_REDIRECT_URI https://trace.noirstack.com/api/auth/callback
set_secret KEYCLOAK_HOME_URL https://trace.noirstack.com
set_secret COLLECTOR_INTERVAL_MS 30000
set_secret COLLECTOR_CASCADES_ENABLED true
set_secret COLLECTOR_CASCADES_URL http://cascades:3000
set_secret COLLECTOR_CASCADES_LEGACY_ENABLED true
set_secret COLLECTOR_PLATFORM_HEALTH_ENABLED true
set_secret COLLECTOR_PLATFORM_HEALTH_URL http://platform-api:3000

COLLECTION_TOKEN="$(grep -E '^COLLECTION_INTERNAL_TOKEN=' <<<"$CASCADES_BLOB" | tail -1 | cut -d= -f2- | sed "s/^['\"]//;s/['\"]$//")"
set_secret COLLECTOR_CASCADES_TOKEN "$COLLECTION_TOKEN"

# Judicium OSINT + workflow trace collector (keys synced via judicium/scripts/sync-osint-secrets.sh)
JUD_BLOB="$(infisical export --projectId="$JUDICIUM_PROJECT_ID" --env="$INFISICAL_ENV" --domain="$INFISICAL_DOMAIN" --format=dotenv 2>/dev/null || true)"
pick_jud() { grep -E "^${1}=" <<<"$JUD_BLOB" 2>/dev/null | tail -1 | cut -d= -f2- | sed "s/^['\"]//;s/['\"]$//" || true; }

JUD_INTERNAL="$(pick_jud JUDICIUM_INTERNAL_URL)"
[[ -z "$JUD_INTERNAL" ]] && JUD_INTERNAL="http://judicium:3002"
set_secret COLLECTOR_JUDICIUM_ENABLED true
set_secret COLLECTOR_JUDICIUM_URL "$JUD_INTERNAL"
set_secret JUDICIUM_PUBLIC_URL "$(pick_jud JUDICIUM_PUBLIC_URL)"
set_secret JUDICIUM_INTERNAL_URL "$JUD_INTERNAL"
set_secret JUDICIUM_URL "$JUD_INTERNAL"

for osint_key in OPENSANCTIONS_API_KEY GOVINFO_API_KEY CAP_API_KEY COURTLISTENER_API_TOKEN \
  COURTLISTENER_BASE_URL OPENSTATES_API_KEY CONGRESS_API_KEY REGULATIONS_API_KEY YENTE_URL; do
  val="$(pick_jud "$osint_key")"
  [[ -n "$val" ]] && set_secret "$osint_key" "$val"
done
[[ -n "$COLLECTION_TOKEN" ]] && set_secret COLLECTOR_JUDICIUM_TOKEN "$COLLECTION_TOKEN"

echo ""
echo "=== Sync PLATFORM_TRACE_* to Cascades project ==="
for kv in \
  "PLATFORM_TRACE_URL=http://platform-trace:3040" \
  "PLATFORM_TRACE_TOKEN=$TRACE_TOKEN" \
  "PLATFORM_TRACE_SOURCE=cascades" \
  "PLATFORM_TRACE_ENABLED=true"; do
  key="${kv%%=*}"
  val="${kv#*=}"
  if [[ "$DRY_RUN" == 1 ]]; then
    echo "  [dry-run] cascades: $key=***"
    continue
  fi
  infisical secrets set "$key=$val" \
    --projectId="$CASCADES_PROJECT_ID" --env="$INFISICAL_ENV" --domain="$INFISICAL_DOMAIN" \
    ${INFISICAL_TOKEN:+--token="$INFISICAL_TOKEN"} || echo "  warn: could not set $key on cascades"
done

echo ""
echo "Done. Re-run deploy: cd $ROOT && bash deploy.sh"
echo "Token file (local backup): $TOKEN_FILE"
