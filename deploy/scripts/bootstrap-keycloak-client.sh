#!/usr/bin/env bash
# Register platform-trace-noirstack OIDC client in Keycloak gateway realm.
# Run after deploy generates deploy/vps/.platform-trace-keycloak-secret
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
KC_SECRET_FILE="${ROOT}/deploy/vps/.platform-trace-keycloak-secret"
CLIENT_ID="${KEYCLOAK_CLIENT_ID:-platform-trace-noirstack}"
REDIRECT_URI="${KEYCLOAK_REDIRECT_URI:-https://trace.noirstack.com/api/auth/callback}"
HOME_URL="${KEYCLOAK_HOME_URL:-https://trace.noirstack.com}"
REALM="${KEYCLOAK_REALM:-gateway}"

if [[ ! -f "$KC_SECRET_FILE" ]]; then
  echo "ERROR: $KC_SECRET_FILE missing — run deploy.sh first" >&2
  exit 1
fi
SECRET="$(cat "$KC_SECRET_FILE")"

if [[ -z "${KEYCLOAK_ADMIN_PASSWORD:-}" ]]; then
  KEYCLOAK_ADMIN_PASSWORD="$(podman exec keycloak printenv KEYCLOAK_ADMIN_PASSWORD 2>/dev/null || true)"
fi
if [[ -z "${KEYCLOAK_ADMIN_PASSWORD:-}" ]]; then
  echo "KEYCLOAK_ADMIN_PASSWORD not set. Create client manually in auth.noirstack.com admin:"
  echo "  Client ID: $CLIENT_ID"
  echo "  Client secret: $SECRET"
  echo "  Redirect URI: $REDIRECT_URI"
  echo "  Web origins: $HOME_URL"
  echo "  Standard flow: ON, Direct access grants: OFF"
  echo "  Assign realm role: trace.noirstack.com (or map in client roles)"
  exit 0
fi

podman exec keycloak /opt/keycloak/bin/kcadm.sh config credentials \
  --server http://127.0.0.1:8080 --realm master --user admin --password "$KEYCLOAK_ADMIN_PASSWORD" >/dev/null

EXISTING="$(podman exec keycloak /opt/keycloak/bin/kcadm.sh get clients -r "$REALM" -q "clientId=$CLIENT_ID" --fields id 2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin); print(d[0]['id'] if d else '')" 2>/dev/null || true)"

if [[ -n "$EXISTING" ]]; then
  echo "Updating existing client $CLIENT_ID ($EXISTING)"
  podman exec keycloak /opt/keycloak/bin/kcadm.sh update "clients/$EXISTING" -r "$REALM" \
    -s "secret=$SECRET" \
    -s "redirectUris=[\"$REDIRECT_URI\"]" \
    -s "webOrigins=[\"$HOME_URL\"]" \
    -s "standardFlowEnabled=true" \
    -s "publicClient=false" >/dev/null
else
  echo "Creating client $CLIENT_ID in realm $REALM"
  podman exec keycloak /opt/keycloak/bin/kcadm.sh create clients -r "$REALM" \
    -s "clientId=$CLIENT_ID" \
    -s "secret=$SECRET" \
    -s "redirectUris=[\"$REDIRECT_URI\"]" \
    -s "webOrigins=[\"$HOME_URL\"]" \
    -s "standardFlowEnabled=true" \
    -s "publicClient=false" \
    -s "protocol=openid-connect" >/dev/null
fi

echo "Done. Assign role trace.noirstack.com to users in Keycloak if not already present."
