import type { Express, Request, Response } from 'express';
import type { TraceStore } from './store.js';
import { buildExecutionTrace } from './trace-builder.js';

function authToken(req: Request): boolean {
  const expected = process.env.PLATFORM_TRACE_TOKEN?.trim();
  if (!expected) return true;
  const header = req.headers['x-platform-trace-token'] as string | undefined;
  return header === expected;
}

function requireIngestAuth(req: Request, res: Response): boolean {
  if (!authToken(req)) {
    res.status(401).json({ error: 'Unauthorized' });
    return false;
  }
  return true;
}

export function registerTraceRoutes(app: Express, store: TraceStore): void {
  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, product: 'platform-trace', service: 'execution-reporter' });
  });

  app.post('/api/v1/ingest/runs', async (req, res) => {
    if (!requireIngestAuth(req, res)) return;
    const body = req.body as Record<string, unknown>;
    const id = String(body.id || '');
    const source = String(body.source || 'unknown');
    if (!id) return res.status(400).json({ error: 'id required' });

    const run = await store.upsertRun({
      id,
      source,
      external_run_id: (body.externalRunId as string) || null,
      workflow_id: (body.workflowId as string) || null,
      workflow_name: (body.workflowName as string) || null,
      status: String(body.status || 'running'),
      execution_mode: (body.executionMode as string) || null,
      started_at: String(body.startedAt || new Date().toISOString()),
      completed_at: (body.completedAt as string) || null,
      metadata: (body.metadata as Record<string, unknown>) || {},
      dag_definition: (body.dag as Record<string, unknown>) || null,
      context: (body.context as Record<string, unknown>) || null,
    });
    res.status(202).json({ accepted: true, run });
  });

  app.post('/api/v1/ingest/events', async (req, res) => {
    if (!requireIngestAuth(req, res)) return;
    const body = req.body as { events?: unknown[] };
    const raw = Array.isArray(body.events) ? body.events : [];
    if (!raw.length) return res.status(400).json({ error: 'events array required' });

    const events = await store.appendEvents(
      raw.map((e) => {
        const ev = e as Record<string, unknown>;
        const payload = (ev.payload as Record<string, unknown>) || ev;
        return {
          run_id: String(ev.runId || payload.runId || ''),
          source: String(ev.source || 'unknown'),
          type: String(ev.type || 'event'),
          timestamp: String(ev.timestamp || payload.timestamp || new Date().toISOString()),
          node_id: (ev.nodeId as string) || (payload.nodeId as string) || null,
          node_type: (ev.nodeType as string) || (payload.nodeType as string) || null,
          status: (ev.status as string) || (payload.status as string) || null,
          payload: payload as Record<string, unknown>,
        };
      }).filter((e) => e.run_id),
    );
    res.status(202).json({ accepted: events.length, events });
  });

  app.get('/api/v1/runs', async (req, res) => {
    const runs = await store.listRuns({
      source: req.query.source as string | undefined,
      status: req.query.status as string | undefined,
      limit: req.query.limit ? Number(req.query.limit) : 100,
    });
    res.json({ runs, count: runs.length });
  });

  app.get('/api/v1/runs/:runId', async (req, res) => {
    const run = await store.getRun(req.params.runId);
    if (!run) return res.status(404).json({ error: 'Run not found' });
    const events = await store.listEvents(req.params.runId, { limit: 2000 });
    res.json({ ...run, events, eventCount: events.length });
  });

  app.get('/api/v1/runs/:runId/events', async (req, res) => {
    const run = await store.getRun(req.params.runId);
    if (!run) return res.status(404).json({ error: 'Run not found' });
    const events = await store.listEvents(req.params.runId, {
      since: req.query.since as string | undefined,
      limit: req.query.limit ? Number(req.query.limit) : 500,
    });
    res.json({ runId: req.params.runId, events, count: events.length });
  });

  app.get('/api/v1/runs/:runId/trace', async (req, res) => {
    const run = await store.getRun(req.params.runId);
    if (!run) return res.status(404).json({ error: 'Run not found' });
    const events = await store.listEvents(req.params.runId, { limit: 2000 });
    const trace = buildExecutionTrace({
      run,
      events,
      dag: run.dag_definition as Parameters<typeof buildExecutionTrace>[0]['dag'],
    });
    res.json(trace);
  });

  app.get('/api/v1/runs/:runId/stream', async (req, res) => {
    const runId = req.params.runId;
    const run = await store.getRun(runId);
    if (!run) return res.status(404).json({ error: 'Run not found' });

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    let events = await store.listEvents(runId);
    let lastSince = events.length ? events[events.length - 1].created_at : undefined;

    res.write(`event: telemetry\ndata: ${JSON.stringify({ type: 'run.started', data: { runId, status: run.status, startedAt: run.started_at, source: run.source } })}\n\n`);
    for (const evt of events) {
      res.write(`event: telemetry\ndata: ${JSON.stringify({ type: evt.type, data: { ...evt.payload, type: evt.type, runId, nodeId: evt.node_id, timestamp: evt.timestamp } })}\n\n`);
    }

    const terminal = ['completed', 'failed', 'cancelled'].includes(run.status);
    if (terminal) {
      res.write(`event: telemetry\ndata: ${JSON.stringify({ type: 'run.completed', data: { runId, status: run.status, completedAt: run.completed_at } })}\n\n`);
      res.end();
      return;
    }

    const interval = setInterval(async () => {
      const latest = await store.getRun(runId);
      if (!latest) { clearInterval(interval); res.end(); return; }
      const newEvents = await store.listEvents(runId, { since: lastSince });
      for (const evt of newEvents) {
        res.write(`event: telemetry\ndata: ${JSON.stringify({ type: evt.type, data: { ...evt.payload, type: evt.type, runId, nodeId: evt.node_id, timestamp: evt.timestamp } })}\n\n`);
        events.push(evt);
      }
      if (newEvents.length) lastSince = newEvents[newEvents.length - 1].created_at;
      if (['completed', 'failed', 'cancelled'].includes(latest.status)) {
        res.write(`event: telemetry\ndata: ${JSON.stringify({ type: 'run.completed', data: { runId, status: latest.status, completedAt: latest.completed_at } })}\n\n`);
        clearInterval(interval);
        res.end();
      }
    }, 1000);

    req.on('close', () => clearInterval(interval));
  });

  app.get('/api/v1/sources', async (_req, res) => {
    const runs = await store.listRuns({ limit: 500 });
    const sources = [...new Set(runs.map((r) => r.source))].sort();
    res.json({ sources });
  });
}
