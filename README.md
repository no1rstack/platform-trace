# Platform Trace

Standalone cross-infrastructure execution tracing and reporting. Not tied to Cascades, Harvest, or Judicium — any service can emit runs and events; collectors sync known platforms; the UI shows live execution maps for everything.

## What it does

- **Ingest** — `POST /api/v1/ingest/events` and `/api/v1/ingest/runs` from any Noir Stack app
- **Collect** — background sync from Cascades (DAG + legacy workflows), Judicium OSINT workflows, platform health probes
- **Store** — Postgres (production) or JSON files (local)
- **Visualize** — execution map UI: start → steps → API calls → data flow → finish

## Repositories

| Remote | URL |
|--------|-----|
| GitLab | `git@git.noirstack.com:2222/hexveil/platform-trace.git` |
| GitHub | `https://github.com/no1rstack/platform-trace` |

## Quick start

```bash
cp .env.example .env
npm install
npm run dev
# UI: http://localhost:3040
# Ingest: POST http://localhost:3040/api/v1/ingest/events
```

## SDK (`@noirstack/trace-client`)

```typescript
import { TraceClient } from '@noirstack/trace-client';

const trace = new TraceClient({
  baseUrl: process.env.PLATFORM_TRACE_URL || 'http://platform-trace:3040',
  source: 'cascades',
  token: process.env.PLATFORM_TRACE_TOKEN,
});

await trace.upsertRun({ id: runId, workflowId: 'passive-domain-collection', status: 'running' });
await trace.emitEvents([{ runId, type: 'node_start', nodeId: 'collect', payload: { ... } }]);
```

## Wiring apps

Set on any service:

```env
PLATFORM_TRACE_URL=http://platform-trace:3040
PLATFORM_TRACE_TOKEN=<shared-secret>
PLATFORM_TRACE_SOURCE=cascades
```

Cascades forwards DAG `run_events` automatically when `PLATFORM_TRACE_URL` is set.

## Collectors (optional)

```env
COLLECTOR_CASCADES_URL=http://cascades:3000
COLLECTOR_CASCADES_ENABLED=true
COLLECTOR_PLATFORM_HEALTH_URL=http://platform-api:3000
COLLECTOR_INTERVAL_MS=30000

# Judicium legal/OSINT workflow runs (legal_research, sanctions_screening, proactive pull)
COLLECTOR_JUDICIUM_ENABLED=true
COLLECTOR_JUDICIUM_URL=http://judicium:3002
COLLECTOR_JUDICIUM_TOKEN=<COLLECTION_INTERNAL_TOKEN from Judicium Infisical>
```

OSINT API keys (`CONGRESS_API_KEY`, `REGULATIONS_API_KEY`, etc.) are synced into this Infisical project from Judicium for deploy parity:

```bash
cd ../judicium && ./scripts/sync-osint-secrets.sh
```

Or bootstrap from Judicium on first deploy:

```bash
./deploy/scripts/bootstrap-infisical-secrets.sh
```

## Deploy

```bash
docker compose -f deploy/compose.vps.yml up -d
```

Public UI target: `https://trace.noirstack.com` (route via Traefik). Access is gated by Keycloak (`auth.noirstack.com`, realm `gateway`, client `platform-trace-noirstack`).

Machine ingest (`POST /api/v1/ingest/*`) and health (`GET /api/health`) stay public; use `X-Platform-Trace-Token` for service-to-service ingest.

After deploy, register the OIDC client in Keycloak (or run `deploy/scripts/bootstrap-keycloak-client.sh` when admin credentials are available). Client secret is generated at `deploy/vps/.platform-trace-keycloak-secret`.

## Related

- **platform-api** — gateway catalog and health (collector input)
- **metrics** — Prometheus/Grafana (complementary; platform-trace is run-level execution maps)
- **Cascades** — primary DAG workflow engine (forwards events when configured)
