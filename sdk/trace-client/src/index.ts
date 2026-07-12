export type TraceRunStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'completed_with_warnings';

export interface TraceRunInput {
  id: string;
  source: string;
  externalRunId?: string;
  workflowId?: string;
  workflowName?: string;
  status: TraceRunStatus | string;
  startedAt?: string;
  completedAt?: string;
  executionMode?: string;
  metadata?: Record<string, unknown>;
  dag?: Record<string, unknown>;
  context?: Record<string, unknown>;
}

export interface TraceEventInput {
  runId: string;
  source?: string;
  type: string;
  timestamp?: string;
  nodeId?: string;
  nodeType?: string;
  status?: string;
  payload?: Record<string, unknown>;
}

export interface TraceClientOptions {
  baseUrl: string;
  source: string;
  token?: string;
  timeoutMs?: number;
  enabled?: boolean;
}

function isEnabled(opts: TraceClientOptions): boolean {
  if (opts.enabled === false) return false;
  return Boolean(opts.baseUrl?.trim());
}

export class TraceClient {
  private base: string;
  private source: string;
  private token?: string;
  private timeoutMs: number;
  private enabled: boolean;

  constructor(options: TraceClientOptions) {
    this.base = options.baseUrl.replace(/\/$/, '');
    this.source = options.source;
    this.token = options.token;
    this.timeoutMs = options.timeoutMs ?? 8000;
    this.enabled = isEnabled(options);
  }

  get active(): boolean {
    return this.enabled;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.token) h['X-Platform-Trace-Token'] = this.token;
    return h;
  }

  private async post(path: string, body: unknown): Promise<void> {
    if (!this.enabled) return;
    try {
      const res = await fetch(`${this.base}${path}`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        console.warn(`[trace-client] ${path} ${res.status}: ${text.slice(0, 120)}`);
      }
    } catch (err) {
      console.warn(`[trace-client] ${path} failed:`, (err as Error).message);
    }
  }

  async upsertRun(run: Omit<TraceRunInput, 'source'> & { source?: string }): Promise<void> {
    await this.post('/api/v1/ingest/runs', {
      ...run,
      source: run.source || this.source,
    });
  }

  async emitEvents(events: Array<Omit<TraceEventInput, 'source'> & { source?: string }>): Promise<void> {
    if (!events.length) return;
    await this.post('/api/v1/ingest/events', {
      events: events.map((e) => ({
        ...e,
        source: e.source || this.source,
        timestamp: e.timestamp || new Date().toISOString(),
      })),
    });
  }

  async emitEvent(event: Omit<TraceEventInput, 'source'> & { source?: string }): Promise<void> {
    await this.emitEvents([event]);
  }

  /** Forward a Cascades-style stream event payload */
  async forwardStreamEvent(runId: string, type: string, data: Record<string, unknown>): Promise<void> {
    await this.emitEvent({
      runId,
      type,
      nodeId: data.nodeId as string | undefined,
      nodeType: data.nodeType as string | undefined,
      status: data.status as string | undefined,
      payload: { ...data, type, runId, timestamp: data.timestamp || new Date().toISOString() },
    });
  }

  /** Map legacy Cascades execution-store record to platform-trace */
  async ingestLegacyExecution(exec: {
    id: string;
    workflow_id: string;
    status: string;
    started_at: string;
    completed_at?: string;
    steps?: Array<{
      name: string;
      status: string;
      started_at: string;
      completed_at?: string;
      output?: unknown;
      error?: string;
    }>;
    error?: string;
  }): Promise<void> {
    const runId = `${this.source}:legacy:${exec.id}`;
    await this.upsertRun({
      id: runId,
      externalRunId: exec.id,
      workflowId: exec.workflow_id,
      status: exec.status,
      startedAt: exec.started_at,
      completedAt: exec.completed_at,
      metadata: { legacy: true, error: exec.error },
    });
    const events: TraceEventInput[] = [
      { runId, type: 'dag_start', status: 'running', payload: { workflowId: exec.workflow_id } },
    ];
    for (const step of exec.steps || []) {
      events.push({
        runId,
        type: 'node_start',
        nodeId: step.name,
        status: 'running',
        payload: { taskName: step.name, timestamp: step.started_at },
      });
      events.push({
        runId,
        type: step.status === 'failed' ? 'node_error' : 'node_complete',
        nodeId: step.name,
        status: step.status,
        payload: {
          taskName: step.name,
          output: step.output,
          error: step.error,
          timestamp: step.completed_at || step.started_at,
        },
      });
    }
    events.push({
      runId,
      type: exec.status === 'failed' ? 'dag_error' : 'dag_complete',
      status: exec.status,
      payload: { timestamp: exec.completed_at || new Date().toISOString() },
    });
    await this.emitEvents(events);
  }
}

export function createTraceClientFromEnv(source: string): TraceClient {
  return new TraceClient({
    baseUrl: process.env.PLATFORM_TRACE_URL || '',
    source: process.env.PLATFORM_TRACE_SOURCE || source,
    token: process.env.PLATFORM_TRACE_TOKEN,
    enabled: process.env.PLATFORM_TRACE_ENABLED !== 'false' && Boolean(process.env.PLATFORM_TRACE_URL),
  });
}
