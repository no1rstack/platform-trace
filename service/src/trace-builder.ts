import type { TraceEventRecord, TraceRunRecord } from './store.js';

export interface TraceApiCall {
  id: string;
  service: string;
  method: string;
  url: string;
  nodeId?: string;
  status: 'running' | 'completed' | 'failed';
  httpStatus?: number;
  durationMs?: number;
  startedAt: string;
  completedAt?: string;
  error?: string;
  requestPreview?: unknown;
  responsePreview?: unknown;
}

export interface TraceStep {
  id: string;
  nodeId?: string;
  name: string;
  status: 'running' | 'completed' | 'failed';
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  detail?: Record<string, unknown>;
}

export interface TraceTimelineEntry {
  id: string;
  timestamp: string;
  type: string;
  label: string;
  status?: string;
  nodeId?: string;
  nodeType?: string;
  durationMs?: number;
  error?: string;
  detail?: Record<string, unknown>;
}

export interface TraceNode {
  id: string;
  type: string;
  label: string;
  status: string;
  layerIndex?: number;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  input?: unknown;
  output?: unknown;
  error?: string;
  apiCalls: TraceApiCall[];
  steps: TraceStep[];
}

export interface TraceEdge {
  id: string;
  source: string;
  target: string;
  status: 'pending' | 'active' | 'completed' | 'failed';
  recordCount?: number;
  activatedAt?: string;
  sourceHandle?: string;
}

export interface ExecutionTrace {
  runId: string;
  source: string;
  workflowId: string;
  workflowName?: string;
  status: string;
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  executionMode?: string;
  externalRunId?: string;
  nodes: TraceNode[];
  edges: TraceEdge[];
  timeline: TraceTimelineEntry[];
  apiCalls: TraceApiCall[];
  branches: Array<{ nodeId: string; expression: string; result: boolean; takenAt: string }>;
}

function summarizePayload(data: unknown, maxLen = 1500): unknown {
  if (data == null) return data;
  try {
    const str = JSON.stringify(data);
    if (str.length <= maxLen) return data;
    return { _truncated: true, _bytes: str.length, _preview: str.slice(0, maxLen) };
  } catch {
    return { _truncated: true, _preview: String(data).slice(0, maxLen) };
  }
}

function countFlowRecords(data: unknown): number | undefined {
  if (!data || typeof data !== 'object') return undefined;
  const o = data as Record<string, unknown>;
  if (Array.isArray(o.findings)) return o.findings.length;
  if (Array.isArray(o.observations)) return o.observations.length;
  if (typeof o.count === 'number') return o.count;
  if (typeof o.inserted === 'number') return o.inserted;
  if (typeof o.submitted === 'number') return o.submitted;
  if (Array.isArray(o.results)) return o.results.length;
  return undefined;
}

function eventLabel(type: string, payload: Record<string, unknown>): string {
  switch (type) {
    case 'dag_start': return 'Workflow started';
    case 'run_accepted': return 'Run accepted';
    case 'layer_start': return `Layer ${payload.layerIndex ?? ''} started`.trim();
    case 'node_start': return `${payload.taskName || payload.nodeId || 'Node'} started`;
    case 'node_complete': return `${payload.taskName || payload.nodeId || 'Node'} completed`;
    case 'node_error': return `${payload.taskName || payload.nodeId || 'Node'} failed`;
    case 'edge_flow': return `Data flow → ${payload.nodeId || 'node'}`;
    case 'api_call_start': return `API ${payload.api?.method || 'POST'} ${payload.api?.url || ''}`.trim();
    case 'api_call_complete': return `API completed (${payload.api?.durationMs ?? '?'}ms)`;
    case 'api_call_error': return `API failed: ${payload.error || 'error'}`;
    case 'step_start': return `Step: ${payload.stepName || 'sub-step'}`;
    case 'step_complete': return `Step done: ${payload.stepName || 'sub-step'}`;
    case 'branch_evaluated': return `Branch ${payload.result ? 'true' : 'false'}`;
    case 'service_call': return `Service ${payload.service}: ${payload.action || 'call'}`;
    case 'dag_complete': return 'Workflow completed';
    case 'dag_error': return 'Workflow failed';
    case 'run_cancelled': return 'Run cancelled';
    default: return type.replace(/_/g, ' ');
  }
}

interface DagDefinition {
  nodes?: Array<{ id: string; type: string; data?: Record<string, unknown> }>;
  edges?: Array<{ id?: string; source: string; target: string; sourceHandle?: string }>;
}

interface DerivedTask {
  node_id: string;
  node_type: string;
  task_name: string;
  status: string;
  layer_index?: number;
  started_at?: string;
  completed_at?: string;
  input?: unknown;
  output?: unknown;
  error?: string;
}

function deriveTasksFromEvents(events: TraceEventRecord[]): DerivedTask[] {
  const byNode = new Map<string, DerivedTask>();
  for (const evt of events) {
    const p = evt.payload || {};
    const nodeId = evt.node_id || (p.nodeId as string);
    if (!nodeId) continue;
    let t = byNode.get(nodeId);
    if (!t) {
      t = {
        node_id: nodeId,
        node_type: evt.node_type || (p.nodeType as string) || 'step',
        task_name: (p.taskName as string) || nodeId,
        status: 'pending',
      };
      byNode.set(nodeId, t);
    }
    if (evt.type === 'node_start') {
      t.status = 'running';
      t.started_at = evt.timestamp;
      if (p.layerIndex != null) t.layer_index = p.layerIndex as number;
    }
    if (evt.type === 'node_complete') {
      t.status = 'completed';
      t.completed_at = evt.timestamp;
      t.output = p.output ?? p;
      if (p.durationMs != null) { /* used below */ }
    }
    if (evt.type === 'node_error') {
      t.status = 'failed';
      t.completed_at = evt.timestamp;
      t.error = (p.error as string) || evt.status || 'failed';
    }
  }
  return [...byNode.values()];
}

export function buildExecutionTrace(input: {
  run: TraceRunRecord;
  events: TraceEventRecord[];
  dag?: DagDefinition | null;
}): ExecutionTrace {
  const { run, events } = input;
  const dag = input.dag || (run.dag_definition as DagDefinition | undefined);
  const tasks = deriveTasksFromEvents(events);
  const taskByNode = new Map(tasks.map((t) => [t.node_id, t]));

  const apiCalls: TraceApiCall[] = [];
  const steps: TraceStep[] = [];
  const branches: ExecutionTrace['branches'] = [];
  const edgeStatus = new Map<string, TraceEdge['status']>();
  const edgeActivated = new Map<string, string>();
  const edgeCounts = new Map<string, number>();
  const nodeApiCalls = new Map<string, TraceApiCall[]>();
  const nodeSteps = new Map<string, TraceStep[]>();
  const timeline: TraceTimelineEntry[] = [];

  let apiSeq = 0;
  let stepSeq = 0;
  const pendingApi = new Map<string, TraceApiCall>();

  for (const evt of events) {
    const p = (evt.payload || {}) as Record<string, unknown>;
    const ts = evt.timestamp || evt.created_at;
    timeline.push({
      id: evt.id,
      timestamp: ts,
      type: evt.type,
      label: eventLabel(evt.type, p),
      status: (p.status as string) || undefined,
      nodeId: p.nodeId as string | undefined,
      nodeType: p.nodeType as string | undefined,
      durationMs: p.durationMs as number | undefined,
      error: p.error as string | undefined,
      detail: summarizePayload(p, 800) as Record<string, unknown>,
    });

    if (evt.type === 'api_call_start') {
      const api = p.api as Record<string, unknown> | undefined;
      const id = `api-${++apiSeq}`;
      const call: TraceApiCall = {
        id,
        service: String(api?.service || 'external'),
        method: String(api?.method || 'POST'),
        url: String(api?.url || ''),
        nodeId: p.nodeId as string | undefined,
        status: 'running',
        startedAt: ts,
        requestPreview: summarizePayload(p.requestPreview ?? p.input),
      };
      apiCalls.push(call);
      pendingApi.set(`${p.nodeId}:${api?.url}`, call);
      const nid = String(p.nodeId || '');
      if (!nodeApiCalls.has(nid)) nodeApiCalls.set(nid, []);
      nodeApiCalls.get(nid)!.push(call);
    }

    if (evt.type === 'api_call_complete' || evt.type === 'api_call_error') {
      const api = p.api as Record<string, unknown> | undefined;
      const key = `${p.nodeId}:${api?.url}`;
      const call = pendingApi.get(key) || apiCalls.filter(c => c.nodeId === p.nodeId && c.status === 'running').pop();
      if (call) {
        call.status = evt.type === 'api_call_error' ? 'failed' : 'completed';
        call.completedAt = ts;
        call.durationMs = (api?.durationMs as number) ?? (p.durationMs as number);
        call.httpStatus = api?.status as number | undefined;
        call.error = p.error as string | undefined;
        call.responsePreview = summarizePayload(p.output ?? p.responsePreview);
        pendingApi.delete(key);
      }
    }

    if (evt.type === 'step_start' || evt.type === 'step_complete') {
      const id = `step-${++stepSeq}`;
      const step: TraceStep = {
        id,
        nodeId: p.nodeId as string | undefined,
        name: String(p.stepName || p.step || 'sub-step'),
        status: evt.type === 'step_complete' ? 'completed' : 'running',
        startedAt: ts,
        completedAt: evt.type === 'step_complete' ? ts : undefined,
        durationMs: p.durationMs as number | undefined,
        detail: (p.detail as Record<string, unknown>) || undefined,
      };
      steps.push(step);
      const nid = String(p.nodeId || '');
      if (!nodeSteps.has(nid)) nodeSteps.set(nid, []);
      nodeSteps.get(nid)!.push(step);
    }

    if (evt.type === 'edge_flow' && Array.isArray(p.edges)) {
      for (const edge of p.edges as Array<{ from: string; to: string; recordCount?: number }>) {
        const eid = `${edge.from}->${edge.to}`;
        edgeStatus.set(eid, 'completed');
        edgeActivated.set(eid, ts);
        if (edge.recordCount != null) edgeCounts.set(eid, edge.recordCount);
      }
    }

    if (evt.type === 'branch_evaluated') {
      branches.push({
        nodeId: String(p.nodeId || ''),
        expression: String(p.expression || ''),
        result: Boolean(p.result),
        takenAt: ts,
      });
    }
  }

  const nodes: TraceNode[] = (dag?.nodes || []).map(n => {
    const task = taskByNode.get(n.id);
    const started = task?.started_at;
    const completed = task?.completed_at;
    let durationMs: number | undefined;
    if (started && completed) {
      durationMs = new Date(completed).getTime() - new Date(started).getTime();
    }
    return {
      id: n.id,
      type: n.type,
      label: String(n.data?.label || n.id),
      status: task?.status || 'pending',
      layerIndex: task?.layer_index,
      startedAt: started,
      completedAt: completed,
      durationMs,
      input: summarizePayload(task?.input),
      output: summarizePayload(task?.output),
      error: task?.error,
      apiCalls: nodeApiCalls.get(n.id) || [],
      steps: nodeSteps.get(n.id) || [],
    };
  });

  for (const task of tasks) {
    if (!nodes.find(n => n.id === task.node_id)) {
      nodes.push({
        id: task.node_id,
        type: task.node_type,
        label: task.task_name || task.node_id,
        status: task.status,
        layerIndex: task.layer_index,
        startedAt: task.started_at,
        completedAt: task.completed_at,
        durationMs: task.started_at && task.completed_at
          ? new Date(task.completed_at).getTime() - new Date(task.started_at).getTime()
          : undefined,
        input: summarizePayload(task.input),
        output: summarizePayload(task.output),
        error: task.error,
        apiCalls: nodeApiCalls.get(task.node_id) || [],
        steps: nodeSteps.get(task.node_id) || [],
      });
    }
  }

  const edges: TraceEdge[] = (dag?.edges || []).map((e, i) => {
    const eid = `${e.source}->${e.target}`;
    return {
      id: e.id || `edge-${i}`,
      source: e.source,
      target: e.target,
      status: edgeStatus.get(eid) || (taskByNode.get(e.target)?.status === 'completed' ? 'completed' : 'pending'),
      recordCount: edgeCounts.get(eid),
      activatedAt: edgeActivated.get(eid),
      sourceHandle: e.sourceHandle,
    };
  });

  const durationMs = run.started_at && run.completed_at
    ? new Date(run.completed_at).getTime() - new Date(run.started_at).getTime()
    : undefined;

  return {
    runId: run.id,
    source: run.source,
    workflowId: run.workflow_id || run.id,
    workflowName: run.workflow_name || undefined,
    status: run.status,
    startedAt: run.started_at,
    completedAt: run.completed_at || undefined,
    durationMs,
    executionMode: run.execution_mode || undefined,
    externalRunId: run.external_run_id || undefined,
    nodes,
    edges,
    timeline: timeline.sort((a, b) => a.timestamp.localeCompare(b.timestamp)),
    apiCalls,
    branches,
  };
}

export { summarizePayload, countFlowRecords };
