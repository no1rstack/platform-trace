import { TraceClient } from '@noirstack/trace-client';
import type { TraceStore } from './store.js';

export type CollectorContext = {
  store: TraceStore;
  trace: TraceClient;
};

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

export async function collectCascadesDagRuns(ctx: CollectorContext, baseUrl: string): Promise<number> {
  const data = (await fetchJson(`${baseUrl.replace(/\/$/, '')}/api/runs?limit=50`)) as { runs?: Array<Record<string, unknown>> };
  const runs = data.runs || [];
  let synced = 0;

  for (const r of runs) {
    const externalId = String(r.id || r.runId || '');
    if (!externalId) continue;
    const runId = `cascades:dag:${externalId}`;
    const existing = await ctx.store.getRun(runId);
    const status = String(r.status || 'unknown');
    const isActive = ['running', 'pending', 'paused', 'retrying'].includes(status);

    await ctx.store.upsertRun({
      id: runId,
      source: 'cascades',
      external_run_id: externalId,
      workflow_id: String(r.workflowId || r.workflow_id || 'inline'),
      workflow_name: String(r.workflowName || r.workflow_name || ''),
      status,
      execution_mode: String(r.executionMode || r.execution_mode || 'inline'),
      started_at: String(r.startedAt || r.started_at || new Date().toISOString()),
      completed_at: (r.completedAt || r.completed_at) as string | null,
      metadata: { collector: 'cascades-dag', nodeStatuses: r.nodeStatuses },
    });

    if (!existing || existing.status !== status || isActive) {
      const detail = (await fetchJson(`${baseUrl}/api/runs/${externalId}/events?limit=500`)) as { events?: Array<{ type: string; payload: Record<string, unknown>; created_at: string }> };
      const events = detail.events || [];
      if (events.length) {
        await ctx.store.appendEvents(
          events.map((e) => ({
            run_id: runId,
            source: 'cascades',
            type: e.type,
            timestamp: (e.payload?.timestamp as string) || e.created_at,
            node_id: (e.payload?.nodeId as string) || null,
            node_type: (e.payload?.nodeType as string) || null,
            status: (e.payload?.status as string) || null,
            payload: e.payload || {},
          })),
        );
      }
      synced++;
    }
  }
  return synced;
}

export async function collectCascadesLegacyExecutions(ctx: CollectorContext, baseUrl: string): Promise<number> {
  let list: Array<Record<string, unknown>> = [];
  try {
    const data = (await fetchJson(`${baseUrl.replace(/\/$/, '')}/api/v1/executions`)) as { executions?: unknown[] } | unknown[];
    list = Array.isArray(data) ? data as Array<Record<string, unknown>> : (data.executions as Array<Record<string, unknown>>) || [];
  } catch {
    return 0;
  }

  let synced = 0;
  for (const exec of list.slice(0, 30)) {
    const id = String(exec.id || '');
    if (!id) continue;
    const runId = `cascades:legacy:${id}`;
    const existing = await ctx.store.getRun(runId);
    if (existing?.status === exec.status) continue;

    await ctx.trace.ingestLegacyExecution({
      id,
      workflow_id: String(exec.workflow_id || 'unknown'),
      status: String(exec.status || 'unknown'),
      started_at: String(exec.started_at || new Date().toISOString()),
      completed_at: exec.completed_at as string | undefined,
      steps: exec.steps as Parameters<TraceClient['ingestLegacyExecution']>[0]['steps'],
      error: exec.error as string | undefined,
    });
    synced++;
  }
  return synced;
}

export async function collectPlatformHealth(ctx: CollectorContext, healthUrl: string): Promise<number> {
  const report = (await fetchJson(`${healthUrl.replace(/\/$/, '')}/platform/health`)) as {
    status: string;
    services?: Array<{ id: string; status: string; latencyMs?: number; detail?: string }>;
  };
  const runId = `platform:health:${new Date().toISOString().slice(0, 16)}`;
  await ctx.store.upsertRun({
    id: runId,
    source: 'platform-api',
    workflow_id: 'platform-health-probe',
    workflow_name: 'Platform Health Probe',
    status: report.status === 'healthy' ? 'completed' : 'failed',
    started_at: new Date().toISOString(),
    completed_at: new Date().toISOString(),
    metadata: { services: report.services },
  });
  const events = (report.services || []).map((svc, i) => ({
    run_id: runId,
    source: 'platform-api',
    type: 'service_call',
    timestamp: new Date().toISOString(),
    node_id: svc.id,
    status: svc.status,
    payload: { service: svc.id, action: 'health_probe', latencyMs: svc.latencyMs, detail: svc.detail },
  }));
  await ctx.store.appendEvents(events);
  return 1;
}

export function startCollectors(store: TraceStore): void {
  const interval = Number(process.env.COLLECTOR_INTERVAL_MS || 30000);
  const trace = new TraceClient({
    baseUrl: process.env.PLATFORM_PUBLIC_URL || 'http://127.0.0.1:3040',
    source: 'platform-trace-collector',
    token: process.env.PLATFORM_TRACE_TOKEN,
  });
  const ctx: CollectorContext = { store, trace };

  const tick = async () => {
    try {
      if (process.env.COLLECTOR_CASCADES_ENABLED === 'true' && process.env.COLLECTOR_CASCADES_URL) {
        const n = await collectCascadesDagRuns(ctx, process.env.COLLECTOR_CASCADES_URL);
        if (n) console.log(`[collector] cascades-dag synced ${n} runs`);
      }
      if (process.env.COLLECTOR_CASCADES_LEGACY_ENABLED === 'true' && process.env.COLLECTOR_CASCADES_URL) {
        const n = await collectCascadesLegacyExecutions(ctx, process.env.COLLECTOR_CASCADES_URL);
        if (n) console.log(`[collector] cascades-legacy synced ${n} runs`);
      }
      if (process.env.COLLECTOR_PLATFORM_HEALTH_ENABLED === 'true' && process.env.COLLECTOR_PLATFORM_HEALTH_URL) {
        await collectPlatformHealth(ctx, process.env.COLLECTOR_PLATFORM_HEALTH_URL);
      }
    } catch (err) {
      console.warn('[collector] tick failed:', (err as Error).message);
    }
  };

  if (
    process.env.COLLECTOR_CASCADES_ENABLED === 'true' ||
    process.env.COLLECTOR_CASCADES_LEGACY_ENABLED === 'true' ||
    process.env.COLLECTOR_PLATFORM_HEALTH_ENABLED === 'true'
  ) {
    console.log(`[collector] started (interval ${interval}ms)`);
    tick();
    setInterval(tick, interval);
  }
}
