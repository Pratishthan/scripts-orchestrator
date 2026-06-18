import path from 'path';

// Generic, domain-agnostic HTML renderer for orchestrator-shaped result payloads.
//
// The renderer knows ONLY about generic orchestrator concepts: a document has optional
// `commands` and optional nested `sections` (recursive). It has no notion of workspaces,
// monorepos, nx, etc. — any such labels arrive purely as data (section.title, section.meta,
// section.statusLabel) and are rendered opaquely.
//
// Columns are discovered as the union of keys across all command entries, so new JSON fields
// appear automatically. Known keys get rich formatting (badges, bars, links); unknown keys
// render as plain text.

export function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function formatMs(ms) {
  if (ms == null || ms === 0) return '—';
  if (ms < 1000) return `${ms}ms`;
  const s = (ms / 1000).toFixed(1);
  return `${s}s`;
}

// Keys that are folded into the synthetic Status column or the Gantt rather than shown raw.
const HANDLED_KEYS = new Set(['success', 'startedAt', 'skipReason']);

// Preferred left-to-right order for known columns (others appended alphabetically).
const KNOWN_ORDER = ['command', 'phase', 'durationMs', 'memoryKb', 'logFile'];

const COLUMN_LABELS = {
  command: 'Command',
  phase: 'Phase',
  durationMs: 'Duration',
  memoryKb: 'Memory',
  logFile: 'Log',
};

function humanizeKey(key) {
  if (COLUMN_LABELS[key]) return COLUMN_LABELS[key];
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/^./, (c) => c.toUpperCase());
}

// Map a command/section to a generic status kind + label.
function statusOf(entry) {
  if (entry.statusKind) {
    return { kind: entry.statusKind, label: entry.statusLabel ?? entry.statusKind };
  }
  if (entry.success === null || entry.success === undefined) {
    // For commands: started-but-not-finished is "running"; otherwise unknown → muted.
    if (entry.startedAt && entry.durationMs == null) return { kind: 'running', label: 'Running' };
    if (entry.success === null) return { kind: 'running', label: 'Running' };
    return { kind: 'muted', label: '—' };
  }
  if (entry.success) return { kind: 'ok', label: 'OK' };
  return { kind: 'fail', label: entry.skipReason || 'Failed' };
}

// Collect every command entry in the document (top-level + all nested sections).
function collectCommands(payload) {
  const all = [];
  const visit = (node) => {
    for (const c of node.commands || []) all.push(c);
    for (const s of node.sections || []) visit(s);
  };
  visit(payload);
  return all;
}

function pct(value, max) {
  return max > 0 && value != null ? (value / max) * 100 : 0;
}

function barCellWrap(text, percent, kind) {
  return `<div class="cellbar"><span>${text}</span><div class="bar ${kind}" style="width:${percent.toFixed(1)}%"></div></div>`;
}

// Render a single command cell for a given column key.
function renderCell(key, c, ctx) {
  const v = c[key];
  switch (key) {
  case 'command':
    return `<code>${escapeHtml(v)}</code>`;
  case 'phase':
    return v != null ? escapeHtml(v) : '—';
  case 'durationMs':
    return v != null ? barCellWrap(formatMs(v), pct(v, ctx.maxDuration), 'dur') : '—';
  case 'memoryKb':
    return v != null ? barCellWrap(`${(v / 1024).toFixed(1)} MB`, pct(v, ctx.maxMemory), 'mem') : '—';
  case 'logFile':
    return v
      ? `<a class="logref" href="file://${escapeHtml(path.resolve(process.cwd(), v))}" title="${escapeHtml(v)}"><code>${escapeHtml(v)}</code></a>`
      : '—';
  default:
    if (v == null) return '—';
    return escapeHtml(typeof v === 'object' ? JSON.stringify(v) : v);
  }
}

function renderCommandsTable(commands, columns, ctx) {
  if (!commands || commands.length === 0) return '';
  const headerCells = ['<th>Status</th>', ...columns.map((k) => `<th>${escapeHtml(humanizeKey(k))}</th>`)];
  const rows = commands
    .map((c) => {
      const st = statusOf(c);
      const cells = columns.map((k) => `<td>${renderCell(k, c, ctx)}</td>`).join('');
      return `<tr class="${st.kind}"><td><span class="badge ${st.kind}">${escapeHtml(st.label)}</span></td>${cells}</tr>`;
    })
    .join('');
  return `<table><thead><tr>${headerCells.join('')}</tr></thead><tbody>${rows}</tbody></table>`;
}

function renderPhasesTable(phases, ctx) {
  if (!phases || phases.length === 0) return '';
  const rows = phases
    .map((p) => {
      const st = statusOf(p);
      return `<tr class="${st.kind}"><td>${escapeHtml(p.name)}</td><td><span class="badge ${st.kind}">${escapeHtml(st.label)}</span></td><td>${barCellWrap(formatMs(p.durationMs), pct(p.durationMs, ctx.maxDuration), 'dur')}</td></tr>`;
    })
    .join('');
  return `<section><h3>Phases</h3><table><thead><tr><th>Phase</th><th>Status</th><th>Duration</th></tr></thead><tbody>${rows}</tbody></table></section>`;
}

// Critical-path Gantt for one command list (uses observed startedAt + durationMs).
function renderGantt(commands, overallDurationMs, hasPhases) {
  const timed = (commands || [])
    .filter((c) => c.startedAt && c.durationMs != null)
    .map((c) => ({ ...c, _start: Date.parse(c.startedAt) }))
    .filter((c) => Number.isFinite(c._start))
    .sort((a, b) => a._start - b._start);
  if (timed.length === 0) return '';

  const runStart = Math.min(...timed.map((c) => c._start));
  const maxEnd = Math.max(...timed.map((c) => c._start + c.durationMs));
  const spanMs = overallDurationMs != null && overallDurationMs > 0 ? overallDurationMs : Math.max(1, maxEnd - runStart);

  // Critical chain: longest command per phase (phases run sequentially, commands within run parallel).
  const criticalKeys = new Set();
  if (hasPhases) {
    const byPhase = new Map();
    for (const c of timed) {
      const arr = byPhase.get(c.phase) || [];
      arr.push(c);
      byPhase.set(c.phase, arr);
    }
    for (const arr of byPhase.values()) {
      const top = arr.reduce((a, b) => (b.durationMs > a.durationMs ? b : a));
      criticalKeys.add(top.command);
    }
  } else {
    timed.forEach((c) => criticalKeys.add(c.command));
  }
  const criticalTotal = timed.filter((c) => criticalKeys.has(c.command)).reduce((sum, c) => sum + c.durationMs, 0);

  const ganttRow = (c) => {
    const offsetPct = ((c._start - runStart) / spanMs) * 100;
    const widthPct = Math.max((c.durationMs / spanMs) * 100, 0.5);
    const crit = criticalKeys.has(c.command);
    const cls = c.success === false ? 'failed' : crit ? 'crit' : '';
    return `<div class="gantt-row"><div class="gantt-label" title="${escapeHtml(c.command)}${c.phase ? ` — ${escapeHtml(c.phase)}` : ''}">${crit ? '★ ' : ''}${escapeHtml(c.command)}</div><div class="gantt-track"><div class="gantt-bar ${cls}" style="left:${offsetPct.toFixed(2)}%;width:${widthPct.toFixed(2)}%" title="${escapeHtml(c.command)} — ${formatMs(c.durationMs)}"><span class="gantt-dur">${formatMs(c.durationMs)}</span></div></div></div>`;
  };

  return `<section><h3>Actual Critical Path</h3><p class="muted">★ marks each phase's bottleneck — the chain that drives wall-clock time. Critical path ≈ <strong>${formatMs(criticalTotal)}</strong>${overallDurationMs != null ? ` of ${formatMs(overallDurationMs)} total` : ''}.</p><div class="gantt">${timed.map(ganttRow).join('')}</div></section>`;
}

function renderMeta(meta) {
  if (!meta || typeof meta !== 'object') return '';
  const items = Object.entries(meta)
    .filter(([, v]) => v != null && v !== '')
    .map(([k, v]) => `<span class="meta-item"><span class="meta-k">${escapeHtml(humanizeKey(k))}</span> ${escapeHtml(typeof v === 'object' ? JSON.stringify(v) : v)}</span>`)
    .join('');
  return items ? `<div class="meta">${items}</div>` : '';
}

// Render one section as a collapsible block.
function renderSection(section, columns, ctx) {
  const st = statusOf(section);
  const hasPhases = (section.phases || []).length > 0;
  const dur = section.overallDurationMs != null ? ` · ${formatMs(section.overallDurationMs)}` : '';
  const inner =
    renderMeta(section.meta) +
    renderPhasesTable(section.phases, ctx) +
    renderGantt(section.commands, section.overallDurationMs, hasPhases) +
    renderCommandsTable(section.commands, columns, ctx) +
    (section.sections || []).map((s) => renderSection(s, columns, ctx)).join('');
  return `<details class="section" open><summary><span class="badge ${st.kind}">${escapeHtml(st.label)}</span> <span class="section-title">${escapeHtml(section.title || 'Section')}</span><span class="section-dur">${dur}</span></summary><div class="section-body">${inner}</div></details>`;
}

const STYLES = `
* { box-sizing: border-box; }
body { font-family: system-ui, sans-serif; margin: 1rem 2rem; background: #1a1a1a; color: #e0e0e0; }
h1 { font-size: 1.5rem; margin-bottom: 0.5rem; }
h3 { font-size: 1rem; color: #a0a0a0; margin: 0.75rem 0 0.4rem; }
.summary { display: flex; gap: 1.5rem; flex-wrap: wrap; margin-bottom: 1.5rem; }
.summary .card { background: #2a2a2a; padding: 1rem 1.25rem; border-radius: 8px; min-width: 140px; }
.summary .card.ok { border-left: 4px solid #22c55e; }
.summary .card.fail { border-left: 4px solid #ef4444; }
.summary .card.running { border-left: 4px solid #3b82f6; }
.summary .card.warn { border-left: 4px solid #f59e0b; }
.summary .card.muted { border-left: 4px solid #666; }
.summary .label { font-size: 0.75rem; text-transform: uppercase; color: #888; }
.summary .value { font-size: 1.25rem; font-weight: 600; }
section { margin-bottom: 1rem; }
table { width: 100%; border-collapse: collapse; background: #2a2a2a; border-radius: 8px; overflow: hidden; margin-bottom: 0.5rem; }
th, td { padding: 0.5rem 0.75rem; text-align: left; vertical-align: top; }
th { background: #333; color: #888; font-weight: 600; font-size: 0.8rem; }
tr.fail { background: rgba(239,68,68,0.08); }
tr.running { background: rgba(59,130,246,0.08); }
.badge { padding: 0.2rem 0.5rem; border-radius: 4px; font-size: 0.8rem; white-space: nowrap; }
.badge.ok { background: #22c55e; color: #0f0f0f; }
.badge.fail { background: #ef4444; color: #fff; }
.badge.running { background: #3b82f6; color: #fff; }
.badge.warn { background: #f59e0b; color: #0f0f0f; }
.badge.muted { background: #555; color: #ddd; }
.cellbar { min-width: 90px; }
.cellbar span { font-size: 0.85em; }
.bar { height: 6px; background: #3b82f6; border-radius: 4px; min-width: 2px; margin-top: 2px; }
.bar.mem { background: #8b5cf6; }
code { font-size: 0.9em; background: #333; padding: 0.1rem 0.3rem; border-radius: 4px; }
a.logref { color: #60a5fa; text-decoration: none; }
a.logref:hover { text-decoration: underline; }
.muted { color: #888; font-size: 0.85rem; margin: 0 0 0.6rem; }
.gantt { background: #2a2a2a; border-radius: 8px; padding: 0.6rem 0.75rem; }
.gantt-row { display: flex; align-items: center; gap: 0.5rem; padding: 2px 0; }
.gantt-label { width: 280px; flex: 0 0 280px; font-family: ui-monospace, monospace; font-size: 0.78rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: #bbb; }
.gantt-track { position: relative; flex: 1; height: 16px; background: #1f1f1f; border-radius: 4px; }
.gantt-bar { position: absolute; top: 0; height: 16px; background: #3b82f6; border-radius: 4px; min-width: 2px; display: flex; align-items: center; overflow: hidden; }
.gantt-bar.crit { background: #f59e0b; }
.gantt-bar.failed { background: #ef4444; }
.gantt-dur { font-size: 0.65rem; color: #0f0f0f; padding: 0 4px; white-space: nowrap; }
details.section { background: #232323; border-radius: 8px; margin-bottom: 0.6rem; padding: 0.25rem 0.75rem; }
details.section > summary { cursor: pointer; padding: 0.5rem 0; display: flex; align-items: center; gap: 0.6rem; }
.section-title { font-weight: 600; }
.section-dur { color: #888; font-size: 0.85rem; }
.section-body { padding: 0.25rem 0 0.5rem; }
.meta { display: flex; flex-wrap: wrap; gap: 0.75rem; margin-bottom: 0.5rem; }
.meta-item { font-size: 0.8rem; color: #bbb; }
.meta-k { color: #777; text-transform: uppercase; font-size: 0.7rem; }
`;

export function renderReportHtml(payload) {
  const { success, timestamp, overallDurationMs, title } = payload;
  const topCommands = payload.commands || [];
  const sections = payload.sections || [];
  const hasTopPhases = (payload.phases || []).length > 0;

  // Global column set + bar scaling across every command in the document.
  const allCommands = collectCommands(payload);
  const present = new Set();
  for (const c of allCommands) for (const k of Object.keys(c)) if (!HANDLED_KEYS.has(k)) present.add(k);
  const ordered = KNOWN_ORDER.filter((k) => present.has(k));
  const extras = [...present].filter((k) => !KNOWN_ORDER.includes(k)).sort();
  const columns = [...ordered, ...extras];

  const ctx = {
    maxDuration: Math.max(0, ...allCommands.map((c) => c.durationMs || 0)),
    maxMemory: Math.max(0, ...allCommands.map((c) => c.memoryKb || 0)),
  };

  const top = statusOf({ success });
  const statusLabel = success === null ? 'Running…' : success ? 'Success' : 'Failed';

  const topBlocks =
    renderPhasesTable(payload.phases, ctx) +
    renderGantt(topCommands, overallDurationMs, hasTopPhases) +
    (topCommands.length > 0
      ? `<section><h3>Commands</h3>${renderCommandsTable(topCommands, columns, ctx)}</section>`
      : '');

  const sectionBlocks = sections.map((s) => renderSection(s, columns, ctx)).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(title || 'Scripts Orchestrator Report')}</title>
  <style>${STYLES}</style>
</head>
<body>
  <h1>${escapeHtml(title || 'Scripts Orchestrator Report')}</h1>
  <div class="summary">
    <div class="card ${top.kind}">
      <div class="label">Status</div>
      <div class="value">${statusLabel}</div>
    </div>
    <div class="card">
      <div class="label">Timestamp</div>
      <div class="value" style="font-size:0.9rem">${escapeHtml(timestamp)}</div>
    </div>
    ${overallDurationMs != null ? `
    <div class="card">
      <div class="label">${success === null ? 'Elapsed' : 'Total time'}</div>
      <div class="value">${formatMs(overallDurationMs)}</div>
    </div>` : ''}
  </div>
  ${topBlocks}
  ${sectionBlocks}
</body>
</html>`;
}
