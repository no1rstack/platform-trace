import { randomUUID } from 'crypto';
import fs from 'fs/promises';
import path from 'path';

export interface TraceRunRecord {
  id: string;
  source: string;
  external_run_id?: string | null;
  workflow_id?: string | null;
  workflow_name?: string | null;
  status: string;
  execution_mode?: string | null;
  started_at: string;
  completed_at?: string | null;
  metadata?: Record<string, unknown>;
  dag_definition?: Record<string, unknown> | null;
  context?: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

export interface TraceEventRecord {
  id: string;
  run_id: string;
  source: string;
  type: string;
  timestamp: string;
  node_id?: string | null;
  node_type?: string | null;
  status?: string | null;
  payload: Record<string, unknown>;
  created_at: string;
}

export interface TraceStore {
  upsertRun(run: Omit<TraceRunRecord, 'created_at' | 'updated_at'> & { created_at?: string; updated_at?: string }): Promise<TraceRunRecord>;
  getRun(id: string): Promise<TraceRunRecord | undefined>;
  listRuns(opts?: { source?: string; status?: string; limit?: number }): Promise<TraceRunRecord[]>;
  appendEvents(events: Array<Omit<TraceEventRecord, 'id' | 'created_at'> & { id?: string }>): Promise<TraceEventRecord[]>;
  listEvents(runId: string, opts?: { since?: string; limit?: number }): Promise<TraceEventRecord[]>;
}

class JsonFile<T extends { id: string }> {
  constructor(private filePath: string) {}

  private async read(): Promise<T[]> {
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      return JSON.parse(raw) as T[];
    } catch {
      return [];
    }
  }

  private async write(rows: T[]): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.writeFile(this.filePath, JSON.stringify(rows, null, 2));
  }

  async getAll(): Promise<T[]> {
    return this.read();
  }

  async get(id: string): Promise<T | undefined> {
    return (await this.read()).find((r) => r.id === id);
  }

  async upsert(row: T): Promise<T> {
    const rows = await this.read();
    const idx = rows.findIndex((r) => r.id === row.id);
    if (idx >= 0) rows[idx] = row;
    else rows.push(row);
    await this.write(rows);
    return row;
  }

  async append(row: T): Promise<T> {
    const rows = await this.read();
    rows.push(row);
    await this.write(rows);
    return row;
  }
}

export class JsonTraceStore implements TraceStore {
  private runs: JsonFile<TraceRunRecord>;
  private events: JsonFile<TraceEventRecord>;

  constructor(dataDir: string) {
    this.runs = new JsonFile(`${dataDir}/trace-runs.json`);
    this.events = new JsonFile(`${dataDir}/trace-events.json`);
  }

  async upsertRun(run: Omit<TraceRunRecord, 'created_at' | 'updated_at'> & { created_at?: string; updated_at?: string }): Promise<TraceRunRecord> {
    const now = new Date().toISOString();
    const existing = await this.runs.get(run.id);
    const record: TraceRunRecord = {
      ...existing,
      ...run,
      created_at: existing?.created_at || run.created_at || now,
      updated_at: now,
    };
    return this.runs.upsert(record);
  }

  async getRun(id: string): Promise<TraceRunRecord | undefined> {
    return this.runs.get(id);
  }

  async listRuns(opts?: { source?: string; status?: string; limit?: number }): Promise<TraceRunRecord[]> {
    let rows = await this.runs.getAll();
    rows.sort((a, b) => b.started_at.localeCompare(a.started_at));
    if (opts?.source) rows = rows.filter((r) => r.source === opts.source);
    if (opts?.status) rows = rows.filter((r) => r.status === opts.status);
    if (opts?.limit) rows = rows.slice(0, opts.limit);
    return rows;
  }

  async appendEvents(events: Array<Omit<TraceEventRecord, 'id' | 'created_at'> & { id?: string }>): Promise<TraceEventRecord[]> {
    const out: TraceEventRecord[] = [];
    const now = new Date().toISOString();
    for (const e of events) {
      const record: TraceEventRecord = {
        id: e.id || `tev-${randomUUID()}`,
        run_id: e.run_id,
        source: e.source,
        type: e.type,
        timestamp: e.timestamp || now,
        node_id: e.node_id ?? null,
        node_type: e.node_type ?? null,
        status: e.status ?? null,
        payload: e.payload || {},
        created_at: now,
      };
      await this.events.append(record);
      out.push(record);
    }
    return out;
  }

  async listEvents(runId: string, opts?: { since?: string; limit?: number }): Promise<TraceEventRecord[]> {
    let rows = (await this.events.getAll()).filter((e) => e.run_id === runId);
    rows.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    if (opts?.since) rows = rows.filter((e) => e.created_at > opts.since!);
    if (opts?.limit) rows = rows.slice(-opts.limit);
    return rows;
  }
}

export function createTraceStore(): TraceStore {
  const dataDir = process.env.PLATFORM_TRACE_DATA_DIR || './data';
  return new JsonTraceStore(dataDir);
}
