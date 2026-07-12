/**
 * Live execution trace — visual DAG map, timeline, API calls, data flow.
 * Consumes GET /api/runs/:id/trace and SSE /api/runs/:id/stream
 */
(function (global) {
  'use strict';

  const STATUS_COLORS = {
    pending: '#6b7280',
    running: '#58a6ff',
    completed: '#3fb950',
    completed_with_warnings: '#d29922',
    failed: '#f85149',
    retrying: '#d29922',
    cancelled: '#6b7280',
  };

  function fmtMs(ms) {
    if (ms == null || ms < 0) return '—';
    if (ms < 1000) return `${Math.round(ms)}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
  }

  function fmtTime(iso) {
    if (!iso) return '—';
    return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 1 });
  }

  function safeJson(data) {
    if (data == null) return '—';
    try {
      return JSON.stringify(data, null, 2);
    } catch {
      return String(data);
    }
  }

  function layoutGraph(nodes, edges) {
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const inDeg = new Map(nodes.map((n) => [n.id, 0]));
    const outEdges = new Map(nodes.map((n) => [n.id, []]));
    for (const e of edges || []) {
      if (!byId.has(e.source) || !byId.has(e.target)) continue;
      inDeg.set(e.target, (inDeg.get(e.target) || 0) + 1);
      outEdges.get(e.source).push(e);
    }
    const layers = [];
    const remaining = new Set(nodes.map((n) => n.id));
    while (remaining.size) {
      const layer = [];
      for (const id of remaining) {
        if ((inDeg.get(id) || 0) === 0) layer.push(id);
      }
      if (!layer.length) break;
      for (const id of layer) remaining.delete(id);
      for (const id of layer) {
        for (const e of outEdges.get(id) || []) {
          inDeg.set(e.target, (inDeg.get(e.target) || 0) - 1);
        }
      }
      layers.push(layer);
    }
    for (const id of remaining) layers.push([id]);

    const positions = new Map();
    const nodeW = 140;
    const nodeH = 52;
    const gapX = 48;
    const gapY = 72;
    const padX = 40;
    const padY = 36;

    layers.forEach((layer, li) => {
      const totalW = layer.length * nodeW + Math.max(0, layer.length - 1) * gapX;
      layer.forEach((id, ni) => {
        positions.set(id, {
          x: padX + ni * (nodeW + gapX) + (li % 2 === 1 ? 20 : 0),
          y: padY + li * (nodeH + gapY),
          w: nodeW,
          h: nodeH,
        });
      });
    });

    const maxX = Math.max(...[...positions.values()].map((p) => p.x + p.w), 400);
    const maxY = Math.max(...[...positions.values()].map((p) => p.y + p.h), 300);

    return { positions, width: maxX + padX, height: maxY + padY, layers };
  }

  function applyLiveEvent(trace, evt) {
    if (!trace || !evt) return trace;
    const type = evt.type;
    const data = evt.data || evt.payload || evt;
    const nodeId = data.nodeId;

    if (type === 'node_start' && nodeId) {
      const n = trace.nodes.find((x) => x.id === nodeId);
      if (n) {
        n.status = 'running';
        n.startedAt = data.timestamp || new Date().toISOString();
      }
    }
    if (type === 'node_complete' && nodeId) {
      const n = trace.nodes.find((x) => x.id === nodeId);
      if (n) {
        n.status = 'completed';
        n.completedAt = data.timestamp || new Date().toISOString();
        n.durationMs = data.durationMs;
        if (data.output) n.output = data.output;
      }
    }
    if (type === 'node_error' && nodeId) {
      const n = trace.nodes.find((x) => x.id === nodeId);
      if (n) {
        n.status = 'failed';
        n.error = data.error;
      }
    }
    if (type === 'edge_flow' && Array.isArray(data.edges)) {
      for (const e of data.edges) {
        const edge = trace.edges.find((x) => x.source === e.from && x.target === e.to);
        if (edge) {
          edge.status = 'completed';
          edge.recordCount = e.recordCount;
          edge.activatedAt = data.timestamp;
        }
      }
    }
    if (type === 'dag_complete' || type === 'run.completed') {
      trace.status = data.status || 'completed';
      trace.completedAt = data.completedAt || data.timestamp;
    }
    if (type === 'dag_error' || type === 'run.failed') {
      trace.status = 'failed';
    }

    if (data.timestamp || data.runId) {
      trace.timeline = trace.timeline || [];
      trace.timeline.push({
        id: `live-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        timestamp: data.timestamp || new Date().toISOString(),
        type,
        label: type.replace(/_/g, ' '),
        nodeId,
        status: data.status,
        durationMs: data.durationMs,
        error: data.error,
        detail: data,
      });
      trace.timeline.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    }

    return trace;
  }

  function renderMap(svg, trace, selectedId, onSelect) {
    const { positions, width, height } = layoutGraph(trace.nodes, trace.edges);
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    svg.innerHTML = '';

    const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
    defs.innerHTML = `<marker id="trace-arrow" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto"><path d="M0,0 L8,3 L0,6 Z" fill="#484f58"/></marker>`;
    svg.appendChild(defs);

    for (const edge of trace.edges || []) {
      const from = positions.get(edge.source);
      const to = positions.get(edge.target);
      if (!from || !to) continue;
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      const x1 = from.x + from.w / 2;
      const y1 = from.y + from.h;
      const x2 = to.x + to.w / 2;
      const y2 = to.y;
      const midY = (y1 + y2) / 2;
      path.setAttribute('d', `M${x1},${y1} C${x1},${midY} ${x2},${midY} ${x2},${y2}`);
      path.setAttribute('class', `exec-trace-edge ${edge.status || 'pending'}`);
      if (edge.recordCount != null) {
        path.setAttribute('title', `${edge.recordCount} records`);
      }
      svg.appendChild(path);
    }

    for (const node of trace.nodes) {
      const pos = positions.get(node.id);
      if (!pos) continue;
      const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      g.setAttribute('class', `exec-trace-node ${node.status || 'pending'}${selectedId === node.id ? ' selected' : ''}`);
      g.setAttribute('transform', `translate(${pos.x},${pos.y})`);
      g.style.cursor = 'pointer';

      const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      rect.setAttribute('width', pos.w);
      rect.setAttribute('height', pos.h);
      rect.setAttribute('rx', '8');
      g.appendChild(rect);

      const isStartEnd = node.type === 'start' || node.type === 'end';
      const title = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      title.setAttribute('x', pos.w / 2);
      title.setAttribute('y', isStartEnd ? pos.h / 2 + 4 : 18);
      title.setAttribute('text-anchor', 'middle');
      title.setAttribute('fill', 'currentColor');
      title.setAttribute('font-size', isStartEnd ? '10' : '11');
      title.setAttribute('font-weight', '600');
      if (isStartEnd) title.setAttribute('class', 'exec-trace-start-end');
      title.textContent = node.label || node.id;
      g.appendChild(title);

      if (!isStartEnd) {
        const sub = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        sub.setAttribute('x', pos.w / 2);
        sub.setAttribute('y', 34);
        sub.setAttribute('text-anchor', 'middle');
        sub.setAttribute('fill', 'var(--fg-muted)');
        sub.setAttribute('font-size', '9');
        sub.textContent = node.type;
        g.appendChild(sub);

        const st = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        st.setAttribute('x', pos.w / 2);
        st.setAttribute('y', 46);
        st.setAttribute('text-anchor', 'middle');
        st.setAttribute('fill', STATUS_COLORS[node.status] || STATUS_COLORS.pending);
        st.setAttribute('font-size', '8');
        st.textContent = `${node.status || 'pending'}${node.durationMs ? ` · ${fmtMs(node.durationMs)}` : ''}`;
        g.appendChild(st);
      }

      g.addEventListener('click', () => onSelect(node.id));
      svg.appendChild(g);
    }
  }

  function renderTimeline(el, trace, selectedId, onSelect) {
    const items = (trace.timeline || []).slice(-80);
    el.innerHTML = items.length
      ? items.map((t) => `
        <div class="exec-trace-timeline-item${selectedId === t.nodeId ? ' selected' : ''}" data-node="${t.nodeId || ''}" data-id="${t.id}">
          <span class="exec-trace-timeline-time">${fmtTime(t.timestamp)}</span>
          <div>
            <div class="exec-trace-timeline-label">${escapeHtml(t.label)}</div>
            <div class="exec-trace-timeline-sub">${t.nodeId ? escapeHtml(t.nodeId) + ' · ' : ''}${t.type}${t.durationMs ? ` · ${fmtMs(t.durationMs)}` : ''}${t.error ? ` · <span style="color:#f85149">${escapeHtml(t.error)}</span>` : ''}</div>
          </div>
        </div>`).join('')
      : '<p style="color:var(--fg-muted);font-size:.75rem">No events yet</p>';

    el.querySelectorAll('.exec-trace-timeline-item').forEach((row) => {
      row.addEventListener('click', () => {
        const nid = row.getAttribute('data-node');
        if (nid) onSelect(nid);
      });
    });
  }

  function renderDetail(el, trace, selectedId) {
    if (!selectedId) {
      el.innerHTML = `<p style="color:var(--fg-muted)">Select a node on the map or timeline to inspect inputs, outputs, API calls, and sub-steps.</p>
        <h4>Run summary</h4>
        <dl class="exec-trace-kv">
          <dt>Status</dt><dd>${escapeHtml(trace.status)}</dd>
          <dt>Duration</dt><dd>${fmtMs(trace.durationMs)}</dd>
          <dt>Nodes</dt><dd>${trace.nodes.length}</dd>
          <dt>API calls</dt><dd>${(trace.apiCalls || []).length}</dd>
          <dt>Branches</dt><dd>${(trace.branches || []).length}</dd>
        </dl>`;
      return;
    }

    const node = trace.nodes.find((n) => n.id === selectedId);
    if (!node) {
      el.innerHTML = '<p>Node not found</p>';
      return;
    }

    const apiCalls = (trace.apiCalls || []).filter((c) => c.nodeId === selectedId);
    const steps = node.steps || [];

    el.innerHTML = `
      <h4>${escapeHtml(node.label || node.id)}</h4>
      <dl class="exec-trace-kv">
        <dt>Type</dt><dd>${escapeHtml(node.type)}</dd>
        <dt>Status</dt><dd style="color:${STATUS_COLORS[node.status] || 'inherit'}">${escapeHtml(node.status)}</dd>
        <dt>Layer</dt><dd>${node.layerIndex ?? '—'}</dd>
        <dt>Duration</dt><dd>${fmtMs(node.durationMs)}</dd>
        ${node.error ? `<dt>Error</dt><dd style="color:#f85149">${escapeHtml(node.error)}</dd>` : ''}
      </dl>
      ${apiCalls.length ? `<h4>API / service calls (${apiCalls.length})</h4>
        ${apiCalls.map((c) => `
          <dl class="exec-trace-kv">
            <dt>Service</dt><dd>${escapeHtml(c.service)}</dd>
            <dt>Request</dt><dd>${escapeHtml(c.method)} ${escapeHtml(c.url)}</dd>
            <dt>Status</dt><dd>${escapeHtml(c.status)}${c.httpStatus ? ` (${c.httpStatus})` : ''} · ${fmtMs(c.durationMs)}</dd>
            ${c.error ? `<dt>Error</dt><dd style="color:#f85149">${escapeHtml(c.error)}</dd>` : ''}
          </dl>
          ${c.responsePreview ? `<pre class="exec-trace-pre">${escapeHtml(safeJson(c.responsePreview))}</pre>` : ''}
        `).join('')}` : ''}
      ${steps.length ? `<h4>Sub-steps (${steps.length})</h4>
        ${steps.map((s) => `<div style="margin-bottom:.5rem"><strong>${escapeHtml(s.name)}</strong> — ${escapeHtml(s.status)} · ${fmtMs(s.durationMs)}</div>`).join('')}` : ''}
      <h4>Input</h4>
      <pre class="exec-trace-pre">${escapeHtml(safeJson(node.input))}</pre>
      <h4>Output</h4>
      <pre class="exec-trace-pre">${escapeHtml(safeJson(node.output))}</pre>
    `;
  }

  function escapeHtml(s) {
    return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function createController(container, opts) {
    let trace = null;
    let selectedId = null;
    let activeTab = 'timeline';
    let sse = null;
    let pollTimer = null;
    const runId = opts.runId;
    const apiBase = opts.apiPrefix || '/api/runs';

    const els = {
      map: null,
      timeline: null,
      detail: null,
      live: null,
      status: null,
    };

    function shell() {
      container.innerHTML = `
        <div class="exec-trace">
          <div class="exec-trace-head">
            <div>
              <div class="exec-trace-title">Execution Trace</div>
              <div class="exec-trace-meta">
                Run <span class="mono">${escapeHtml(runId)}</span>
                · <span id="exec-trace-status">loading…</span>
              </div>
            </div>
            <div id="exec-trace-live" class="exec-trace-live" hidden><span class="exec-trace-live-dot"></span> Live</div>
          </div>
          <div class="exec-trace-body">
            <div class="exec-trace-map-wrap">
              <svg class="exec-trace-map" id="exec-trace-svg" role="img" aria-label="Workflow execution map"></svg>
            </div>
            <div class="exec-trace-side">
              <div class="exec-trace-tabs">
                <button type="button" class="exec-trace-tab active" data-tab="timeline">Timeline</button>
                <button type="button" class="exec-trace-tab" data-tab="detail">Detail</button>
              </div>
              <div class="exec-trace-panel" id="exec-trace-timeline"></div>
              <div class="exec-trace-panel" id="exec-trace-detail" hidden></div>
            </div>
          </div>
          <div class="exec-trace-legend">
            <span class="l-pending">Pending</span>
            <span class="l-running">Running</span>
            <span class="l-completed">Completed</span>
            <span class="l-failed">Failed</span>
          </div>
        </div>`;

      els.map = container.querySelector('#exec-trace-svg');
      els.timeline = container.querySelector('#exec-trace-timeline');
      els.detail = container.querySelector('#exec-trace-detail');
      els.live = container.querySelector('#exec-trace-live');
      els.status = container.querySelector('#exec-trace-status');

      container.querySelectorAll('.exec-trace-tab').forEach((btn) => {
        btn.addEventListener('click', () => {
          activeTab = btn.getAttribute('data-tab');
          container.querySelectorAll('.exec-trace-tab').forEach((b) => b.classList.toggle('active', b === btn));
          els.timeline.hidden = activeTab !== 'timeline';
          els.detail.hidden = activeTab !== 'detail';
        });
      });
    }

    function selectNode(id) {
      selectedId = id;
      render();
      if (activeTab !== 'detail') {
        activeTab = 'detail';
        container.querySelectorAll('.exec-trace-tab').forEach((b) => {
          b.classList.toggle('active', b.getAttribute('data-tab') === 'detail');
        });
        els.timeline.hidden = true;
        els.detail.hidden = false;
      }
      opts.onSelect?.(id);
    }

    function render() {
      if (!trace) return;
      renderMap(els.map, trace, selectedId, selectNode);
      renderTimeline(els.timeline, trace, selectedId, selectNode);
      renderDetail(els.detail, trace, selectedId);
      els.status.textContent = `${trace.workflowName || trace.workflowId} · ${trace.status} · ${fmtMs(trace.durationMs)}`;
      const live = ['running', 'pending', 'paused', 'retrying'].includes(trace.status);
      els.live.hidden = !live;
    }

    async function loadTrace() {
      const res = await fetch(`${apiBase}/${encodeURIComponent(runId)}/trace`);
      if (!res.ok) throw new Error(`Trace load failed: ${res.status}`);
      trace = await res.json();
      render();
    }

    function connectSSE() {
      if (sse) { sse.close(); sse = null; }
      if (!['running', 'pending', 'paused', 'retrying'].includes(trace?.status)) return;

      sse = new EventSource(`${apiBase}/${encodeURIComponent(runId)}/stream`);
      sse.addEventListener('telemetry', (ev) => {
        try {
          const msg = JSON.parse(ev.data);
          trace = applyLiveEvent(trace, msg);
          render();
          if (['run.completed', 'run.failed', 'run.cancelled', 'dag_complete', 'dag_error'].includes(msg.type)) {
            sse?.close();
            sse = null;
            els.live.hidden = true;
            loadTrace().catch(() => {});
          }
        } catch (e) {
          console.warn('trace SSE parse', e);
        }
      });
      sse.onerror = () => {
        sse?.close();
        sse = null;
      };
    }

    function startPollFallback() {
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = setInterval(async () => {
        if (!['running', 'pending', 'paused', 'retrying'].includes(trace?.status)) {
          clearInterval(pollTimer);
          return;
        }
        try {
          await loadTrace();
        } catch { /* ignore */ }
      }, 3000);
    }

    async function start() {
      shell();
      await loadTrace();
      connectSSE();
      startPollFallback();
    }

    function destroy() {
      if (sse) { sse.close(); sse = null; }
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
      container.innerHTML = '';
    }

    return { start, destroy, refresh: loadTrace, getTrace: () => trace };
  }

  global.ExecutionTrace = { createController, applyLiveEvent, layoutGraph };
})(typeof window !== 'undefined' ? window : globalThis);
