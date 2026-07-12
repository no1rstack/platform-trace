import { describe, it, expect } from 'vitest';
import { buildExecutionTrace } from '../src/trace-builder.js';
import type { TraceRunRecord, TraceEventRecord } from '../src/store.js';

describe('buildExecutionTrace', () => {
  it('builds trace from platform-trace events', () => {
    const run: TraceRunRecord = {
      id: 'cascades:dag:run-1',
      source: 'cascades',
      external_run_id: 'run-1',
      workflow_id: 'passive-domain-collection',
      workflow_name: 'Passive Domain',
      status: 'completed',
      started_at: '2026-07-12T10:00:00.000Z',
      completed_at: '2026-07-12T10:00:05.000Z',
      created_at: '2026-07-12T10:00:00.000Z',
      updated_at: '2026-07-12T10:00:05.000Z',
      dag_definition: {
        nodes: [
          { id: 'start', type: 'start', data: {} },
          { id: 'collect', type: 'harvest_connector', data: { connector: 'dns' } },
          { id: 'end', type: 'end', data: {} },
        ],
        edges: [
          { source: 'start', target: 'collect' },
          { source: 'collect', target: 'end' },
        ],
      },
    };
    const events: TraceEventRecord[] = [
      {
        id: 'e1', run_id: run.id, source: 'cascades', type: 'dag_start',
        timestamp: '2026-07-12T10:00:00.100Z', payload: {}, created_at: '2026-07-12T10:00:00.100Z',
      },
      {
        id: 'e2', run_id: run.id, source: 'cascades', type: 'node_start', node_id: 'collect',
        timestamp: '2026-07-12T10:00:01.000Z',
        payload: { nodeId: 'collect', taskName: 'DNS', status: 'running' },
        created_at: '2026-07-12T10:00:01.000Z',
      },
      {
        id: 'e3', run_id: run.id, source: 'cascades', type: 'node_complete', node_id: 'collect',
        timestamp: '2026-07-12T10:00:04.000Z',
        payload: { nodeId: 'collect', output: { findings: [1, 2] }, durationMs: 3000 },
        created_at: '2026-07-12T10:00:04.000Z',
      },
    ];
    const trace = buildExecutionTrace({ run, events });
    expect(trace.source).toBe('cascades');
    expect(trace.nodes.find((n) => n.id === 'collect')?.status).toBe('completed');
    expect(trace.apiCalls).toBeDefined();
  });
});
