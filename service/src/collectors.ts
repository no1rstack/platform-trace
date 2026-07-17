import { TraceClient } from '@noirstack/trace-client';
import type { TraceStore } from './store.js';

export type CollectorContext = {
  store: TraceStore;
  trace: TraceClient;
};

async function fetchJson(url: string, headers?: Record<string, string>): Promise<unknown> {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(15000),
    headers,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

function cascadesCollectorHeaders(): Record<string, string> | undefined {
  const token = process.env.COLLECTOR_CASCADES_TOKEN?.trim();
  return token ? { 'x-collection-token': token } : undefined;
}

export async function collectCascadesDagRuns(ctx: CollectorContext, baseUrl: string): Promise<number> {
  const headers = cascadesCollectorHeaders();
  const data = (await fetchJson(`${baseUrl.replace(/\/$/, '')}/api/runs?limit=50`, headers)) as { runs?: Array<Record<string, unknown>> };
  const runs = data.runs || [];
  let synced = 0;

  for (const r of runs) {
    const externalId = String(r.id || r.runId || '');
    if (!externalId) continue;
    const runId = `cascades:dag:${externalId}`;
    const existing = await ctx.store.getRun(runId);
    const status = String(r.status || 'unknown');
    const isActive = ['running', 'pending', 'paused', 'retrying'].includes(status);
    const existingEvents = existing ? await ctx.store.listEvents(runId, { limit: 1 }) : [];

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

    if (!existing || existing.status !== status || isActive || existingEvents.length === 0) {
      const detail = (await fetchJson(`${baseUrl}/api/runs/${externalId}/events?limit=500`, headers)) as { events?: Array<{ type: string; payload: Record<string, unknown>; created_at: string }> };
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
    const data = (await fetchJson(`${baseUrl.replace(/\/$/, '')}/api/v1/executions`, cascadesCollectorHeaders())) as { executions?: unknown[] } | unknown[];
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

export async function collectJudiciumWorkflowRuns(ctx: CollectorContext, baseUrl: string): Promise<number> {
  const token = process.env.COLLECTOR_JUDICIUM_TOKEN?.trim();
  const headers: Record<string, string> = {};
  if (token) headers['x-collection-token'] = token;

  const data = (await fetchJson(`${baseUrl.replace(/\/$/, '')}/api/workflows/runs`, headers)) as {
    runs?: Array<Record<string, unknown>>;
  };
  const runs = data.runs || [];
  let synced = 0;

  for (const r of runs.slice(0, 40)) {
    const externalId = String(r.id || '');
    if (!externalId) continue;
    const runId = `judicium:workflow:${externalId}`;
    const existing = await ctx.store.getRun(runId);
    const status = String(r.status || 'unknown');

    await ctx.store.upsertRun({
      id: runId,
      source: 'judicium',
      external_run_id: externalId,
      workflow_id: String(r.workflowType || r.template || r.playbook || 'osint'),
      workflow_name: String(r.workflowType || r.template || r.playbook || 'OSINT Workflow'),
      status,
      execution_mode: 'orchestrator',
      started_at: String(r.startedAt || r.createdAt || new Date().toISOString()),
      completed_at: (r.status === 'completed' || r.status === 'failed')
        ? String(r.updatedAt || r.completedAt || '')
        : null,
      metadata: {
        collector: 'judicium-workflows',
        phase: r.phase,
        detail: r.detail,
        query: (r.input as Record<string, unknown> | undefined)?.query,
      },
    });

    if (!existing || existing.status !== status) {
      await ctx.store.appendEvents([{
        run_id: runId,
        source: 'judicium',
        type: status === 'completed' ? 'workflow_complete' : 'workflow_progress',
        timestamp: new Date().toISOString(),
        node_id: String(r.phase || 'workflow'),
        status,
        payload: {
          phase: r.phase,
          detail: r.detail,
          outputKeys: r.output ? Object.keys(r.output as object) : [],
        },
      }]);
      synced++;
    }
  }
  return synced;
}

export function startCollectors(store: TraceStore): void {
  const interval = Number(process.env.COLLECTOR_INTERVAL_MS || 30000);
  const internalBase =
    process.env.PLATFORM_TRACE_INTERNAL_URL ||
    `http://127.0.0.1:${process.env.PORT || '3040'}`;
  const trace = new TraceClient({
    baseUrl: internalBase,
    source: 'platform-trace-collector',
    token: process.env.PLATFORM_TRACE_TOKEN,
  });
  const ctx: CollectorContext = { store, trace };

  const tick = async () => {
    if (process.env.COLLECTOR_CASCADES_ENABLED === 'true' && process.env.COLLECTOR_CASCADES_URL) {
      try {
        const n = await collectCascadesDagRuns(ctx, process.env.COLLECTOR_CASCADES_URL);
        if (n) console.log(`[collector] cascades-dag synced ${n} runs`);
      } catch (err) {
        console.warn('[collector] cascades-dag failed:', (err as Error).message);
      }
    }
    if (process.env.COLLECTOR_CASCADES_LEGACY_ENABLED === 'true' && process.env.COLLECTOR_CASCADES_URL) {
      try {
        const n = await collectCascadesLegacyExecutions(ctx, process.env.COLLECTOR_CASCADES_URL);
        if (n) console.log(`[collector] cascades-legacy synced ${n} runs`);
      } catch (err) {
        console.warn('[collector] cascades-legacy failed:', (err as Error).message);
      }
    }
    if (process.env.COLLECTOR_PLATFORM_HEALTH_ENABLED === 'true' && process.env.COLLECTOR_PLATFORM_HEALTH_URL) {
      try {
        await collectPlatformHealth(ctx, process.env.COLLECTOR_PLATFORM_HEALTH_URL);
      } catch (err) {
        console.warn('[collector] platform-health failed:', (err as Error).message);
      }
    }
    if (process.env.COLLECTOR_JUDICIUM_ENABLED === 'true' && process.env.COLLECTOR_JUDICIUM_URL) {
      try {
        const n = await collectJudiciumWorkflowRuns(ctx, process.env.COLLECTOR_JUDICIUM_URL);
        if (n) console.log(`[collector] judicium-workflows synced ${n} runs`);
      } catch (err) {
        console.warn('[collector] judicium-workflows failed:', (err as Error).message);
      }
    }
  };

  if (
    process.env.COLLECTOR_CASCADES_ENABLED === 'true' ||
    process.env.COLLECTOR_CASCADES_LEGACY_ENABLED === 'true' ||
    process.env.COLLECTOR_PLATFORM_HEALTH_ENABLED === 'true' ||
    process.env.COLLECTOR_JUDICIUM_ENABLED === 'true'
  ) {
    console.log(`[collector] started (interval ${interval}ms)`);
    tick();
    setInterval(tick, interval);
  }
}
