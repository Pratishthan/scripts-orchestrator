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

// Compact memory formatting (input in KB): MB up to ~1 GB, then GB.
export function formatMem(kb) {
  if (kb == null) return '—';
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
  return `${(mb / 1024).toFixed(1)} GB`;
}

// Default heat thresholds (fraction of the heaviest command in the run).
export const DEFAULT_HEAT_THRESHOLDS = { mid: 0.33, high: 0.66 };

// Normalize caller-supplied thresholds, clamping to (0,1) and ensuring mid < high.
// Falls back to a default for any missing/invalid value.
export function normalizeHeatThresholds(t) {
  const def = DEFAULT_HEAT_THRESHOLDS;
  const clamp = (v, fallback) => (Number.isFinite(v) && v > 0 && v < 1 ? v : fallback);
  let mid = clamp(t?.mid, def.mid);
  let high = clamp(t?.high, def.high);
  if (mid >= high) { mid = def.mid; high = def.high; }
  return { mid, high };
}

// Classify a value relative to the maximum in the run (low / mid / high), so heavy or
// slow commands can be flagged green→amber→red. Thresholds (fractions of the run's max)
// are configurable; defaults are used otherwise. Returns null when no value was recorded.
export function heatLevel(value, max, thresholds = DEFAULT_HEAT_THRESHOLDS) {
  if (value == null || !(max > 0)) return null;
  const frac = value / max;
  if (frac >= thresholds.high) return 'high';
  if (frac >= thresholds.mid) return 'mid';
  return 'low';
}

// Classify a command's memory use relative to the heaviest in the run, so the
// Gantt can flag which bars are too memory-hungry to run alongside others.
export function memoryHeat(memoryKb, maxMemory, thresholds = DEFAULT_HEAT_THRESHOLDS) {
  return heatLevel(memoryKb, maxMemory, thresholds);
}

// Classify a command's average CPU use relative to the most CPU-hungry in the run, so
// heavy parallel CPU consumers (which contend for cores when overlapped) stand out.
export function cpuHeat(cpuPercent, maxCpu, thresholds = DEFAULT_HEAT_THRESHOLDS) {
  return heatLevel(cpuPercent, maxCpu, thresholds);
}

// Keys that are folded into the synthetic Status column or the Gantt rather than shown raw.
const HANDLED_KEYS = new Set(['success', 'startedAt', 'skipReason']);

// Preferred left-to-right order for known columns (others appended alphabetically).
const KNOWN_ORDER = ['command', 'phase', 'durationMs', 'memoryKb', 'cpuPercent', 'logFile'];

const COLUMN_LABELS = {
  command: 'Command',
  phase: 'Phase',
  durationMs: 'Duration',
  memoryKb: 'Memory',
  cpuPercent: 'CPU',
  logFile: 'Log',
};

function humanizeKey(key) {
  if (COLUMN_LABELS[key]) return COLUMN_LABELS[key];
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/^./, (c) => c.toUpperCase());
}

// True when a command/section entry is currently in flight: started-but-not-finished, or an
// explicit success:null. Shared by statusOf (badge/row colour) and hasRunning (float-to-top).
function isRunning(entry) {
  if (entry.statusKind) return entry.statusKind === 'running';
  if (entry.success === null || entry.success === undefined) {
    if (entry.startedAt && entry.durationMs == null) return true;
    if (entry.success === null) return true;
  }
  return false;
}

// Map a command/section to a generic status kind + label.
function statusOf(entry) {
  if (entry.statusKind) {
    return { kind: entry.statusKind, label: entry.statusLabel ?? entry.statusKind };
  }
  if (entry.success === null || entry.success === undefined) {
    if (isRunning(entry)) return { kind: 'running', label: 'Running' };
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

// Like collectCommands, but tags each command with the title of the nearest enclosing section
// (`_section`), so the cross-section overall timeline can label which workspace/section a command
// came from. Top-level commands (no enclosing section) get `_section: null`.
function collectCommandsTagged(payload) {
  const all = [];
  const visit = (node, label) => {
    for (const c of node.commands || []) all.push({ ...c, _section: label });
    for (const s of node.sections || []) visit(s, s.title || label);
  };
  visit(payload, null);
  return all;
}

// True when this node — or any command/section nested beneath it — recorded a genuine failure
// (success === false). Used to decide what to expand by default and what the "only failures"
// filter must keep. A running/unknown command (success null/undefined) is NOT a failure.
function hasFailure(node) {
  if (!node) return false;
  if ((node.commands || []).some((c) => c.success === false)) return true;
  return (node.sections || []).some(hasFailure);
}

// True when this node — or any command/section nested beneath it — has a command currently in
// flight. Used to float in-progress work to the top and keep it expanded, same as hasFailure.
function hasRunning(node) {
  if (!node) return false;
  if ((node.commands || []).some(isRunning)) return true;
  return (node.sections || []).some(hasRunning);
}

// Priority ordering: sections with something running sort first (live work is what the reader
// wants to watch), then sections with a failure, then clean/passing sections last. Stable within
// each tier — order is otherwise preserved.
function sectionRank(node) {
  if (hasRunning(node)) return 0;
  if (hasFailure(node)) return 1;
  return 2;
}

function failFirst(nodes) {
  return [...nodes].sort((a, b) => sectionRank(a) - sectionRank(b));
}

function pct(value, max) {
  return max > 0 && value != null ? (value / max) * 100 : 0;
}

function barCellWrap(text, percent, kind) {
  return `<div class="cellbar"><span>${text}</span><div class="bar ${kind}" style="width:${percent.toFixed(1)}%"></div></div>`;
}

// Duration cell: green→amber→red heat scale relative to the slowest command in the run,
// applied to both the bar and the value text, so the slowest commands stand out at a glance.
function durCellWrap(durationMs, maxDuration, thresholds) {
  const heat = heatLevel(durationMs, maxDuration, thresholds);
  const heatCls = heat ? ` dur-${heat}` : '';
  const percent = pct(durationMs, maxDuration);
  return `<div class="cellbar"><span class="durval${heatCls}">${formatMs(durationMs)}</span><div class="bar dur${heatCls}" style="width:${percent.toFixed(1)}%"></div></div>`;
}

// Memory cell: same green→amber→red heat scale as the Gantt, applied to both the
// bar and the value text, so the table and the Gantt read identically.
function memCellWrap(memoryKb, maxMemory, thresholds) {
  const heat = memoryHeat(memoryKb, maxMemory, thresholds);
  const heatCls = heat ? ` mem-${heat}` : '';
  const percent = pct(memoryKb, maxMemory);
  return `<div class="cellbar"><span class="memval${heatCls}">${formatMem(memoryKb)}</span><div class="bar mem${heatCls}" style="width:${percent.toFixed(1)}%"></div></div>`;
}

// CPU cell: same green→amber→red heat scale, relative to the most CPU-hungry command in the
// run, applied to both the bar and the value text. The value is average CPU utilisation —
// 100% = one core busy for the whole command, >100% = multiple cores on average.
function cpuCellWrap(cpuPercent, maxCpu, thresholds) {
  const heat = cpuHeat(cpuPercent, maxCpu, thresholds);
  const heatCls = heat ? ` cpu-${heat}` : '';
  const percent = pct(cpuPercent, maxCpu);
  return `<div class="cellbar"><span class="cpuval${heatCls}">${cpuPercent}%</span><div class="bar cpu${heatCls}" style="width:${percent.toFixed(1)}%"></div></div>`;
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
    return v != null ? durCellWrap(v, ctx.maxDuration, ctx.durationHeatThresholds) : '—';
  case 'memoryKb':
    return v != null ? memCellWrap(v, ctx.maxMemory, ctx.heatThresholds) : '—';
  case 'cpuPercent':
    // Average CPU utilisation: 100% = one core busy for the whole run; >100% = multiple cores.
    return v != null ? cpuCellWrap(v, ctx.maxCpu, ctx.cpuHeatThresholds) : '—';
  case 'logFile': {
    const base = ctx.repoRoot || process.cwd();
    return v
      ? `<a class="logref" href="file://${escapeHtml(path.resolve(base, v))}" title="${escapeHtml(v)}"><code>${escapeHtml(v)}</code></a>`
      : '—';
  }
  default:
    if (v == null) return '—';
    return escapeHtml(typeof v === 'object' ? JSON.stringify(v) : v);
  }
}

function renderCommandsTable(commands, columns, ctx) {
  if (!commands || commands.length === 0) return '';
  const headerCells = ['<th>Status</th>', ...columns.map((k) => `<th>${escapeHtml(humanizeKey(k))}</th>`)];
  // Float running commands to the very top (live work to watch), then failed ones, so neither
  // hides below passing rows.
  const rowRank = (c) => (isRunning(c) ? 0 : c.success === false ? 1 : 2);
  const ordered = [...commands].sort((a, b) => rowRank(a) - rowRank(b));
  const rows = ordered
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
function renderGantt(commands, overallDurationMs, hasPhases, ctx = {}) {
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

  const anyMemory = timed.some((c) => c.memoryKb != null);

  const ganttRow = (c) => {
    const offsetPct = ((c._start - runStart) / spanMs) * 100;
    const widthPct = Math.max((c.durationMs / spanMs) * 100, 0.5);
    const crit = criticalKeys.has(c.command);
    const cls = c.success === false ? 'failed' : crit ? 'crit' : '';
    const heat = memoryHeat(c.memoryKb, ctx.maxMemory, ctx.heatThresholds);
    const heatCls = heat ? ` mem-${heat}` : '';
    const memTitle = c.memoryKb != null ? ` · ${formatMem(c.memoryKb)}` : '';
    const memChip = anyMemory
      ? `<div class="gantt-mem${heat ? ` mem-${heat}` : ''}">${c.memoryKb != null ? formatMem(c.memoryKb) : '—'}</div>`
      : '';
    return `<div class="gantt-row"><div class="gantt-label" title="${escapeHtml(c.command)}${c.phase ? ` — ${escapeHtml(c.phase)}` : ''}">${crit ? '★ ' : ''}${escapeHtml(c.command)}</div>${memChip}<div class="gantt-track"><div class="gantt-bar ${cls}${heatCls}" style="left:${offsetPct.toFixed(2)}%;width:${widthPct.toFixed(2)}%" title="${escapeHtml(c.command)} — ${formatMs(c.durationMs)}${memTitle}"><span class="gantt-dur">${formatMs(c.durationMs)}</span></div></div></div>`;
  };

  const t = ctx.heatThresholds || DEFAULT_HEAT_THRESHOLDS;
  const memLegend = anyMemory
    ? ' Bar outline + memory column show peak RSS (green→red, relative to the heaviest command:' +
      ` amber ≥ ${Math.round(t.mid * 100)}%, red ≥ ${Math.round(t.high * 100)}%) so you can spot which` +
      ' parallel commands are too memory-hungry to overlap.'
    : '';
  return `<details class="foldable"><summary>Actual Critical Path</summary><p class="muted">★ marks each phase's bottleneck — the chain that drives wall-clock time. Critical path ≈ <strong>${formatMs(criticalTotal)}</strong>${overallDurationMs != null ? ` of ${formatMs(overallDurationMs)} total` : ''}.${memLegend}</p><div class="gantt">${timed.map(ganttRow).join('')}</div></details>`;
}

// Cross-section "Overall Critical Path". The per-section Gantt above credits only each phase's
// longest command and assumes phases run back-to-back with zero gaps — an IDEAL lower bound that
// understates wall-clock whenever stages serialise (concurrency caps, governor throttling) or leave
// dead air between them. This view instead places EVERY command across EVERY section on one absolute
// wall-clock timeline and reports what actually drove the total time:
//   • Wall-clock (makespan)  — last end minus first start across the whole run.
//   • Observed critical path — the longest chain of commands that ran strictly one after another
//                              (no overlap); the part of the run no extra parallelism could shorten.
//   • Idle / dead-air        — wall-clock during which NOTHING was running (gaps between stages) —
//                              the direct signal that stages were not packed tightly.
// "Observed" because there are no declared dependencies: the chain is what the schedule forced
// sequential, not a causal DAG. It answers "what filled the wall-clock", which is the question.
function renderOverallCriticalPath(payload, ctx = {}) {
  const overall = payload.overallDurationMs;
  let cmds = collectCommandsTagged(payload)
    .filter((c) => c.startedAt && c.durationMs != null)
    .map((c) => {
      const start = Date.parse(c.startedAt);
      return { ...c, _start: start, _end: start + c.durationMs };
    })
    .filter((c) => Number.isFinite(c._start))
    .sort((a, b) => a._start - b._start || a._end - b._end);
  if (cmds.length < 2) return ''; // a single command is its own trivial critical path

  // Drop commands carried forward from a PRIOR run window. Cache-replayed (CACHED) lanes keep their
  // old results JSON — and old `startedAt` — so without this they would stretch the timeline back to
  // an earlier run. The genuine run cannot be longer than overallDurationMs, so any command that
  // ended more than one run-length (+2s jitter, matching the aggregate's staleness tolerance) before
  // the latest end must belong to an earlier run.
  let droppedStale = 0;
  if (overall != null && overall > 0) {
    const lastEndAll = Math.max(...cmds.map((c) => c._end));
    const windowFloor = lastEndAll - overall - 2000;
    const fresh = cmds.filter((c) => c._end >= windowFloor);
    if (fresh.length > 0 && fresh.length < cmds.length) {
      droppedStale = cmds.length - fresh.length;
      cmds = fresh;
    }
  }
  if (cmds.length < 2) return '';

  const runStart = Math.min(...cmds.map((c) => c._start));
  const lastEnd = Math.max(...cmds.map((c) => c._end));
  const observedSpan = Math.max(1, lastEnd - runStart);
  // Prefer the orchestrator's own measured run duration as the wall-clock: it includes startup,
  // teardown and scheduling overhead that elapses outside any single command but is still part of
  // the "overall operation" — and that gap then shows up honestly as idle / dead-air below.
  const makespan = overall != null && overall > observedSpan ? overall : observedSpan;

  // Observed critical path: longest-duration chain of non-overlapping commands. DP over start order —
  // chainMs[i] = max total duration of a chain ending at command i; pred[i] reconstructs it.
  const chainMs = cmds.map((c) => c.durationMs);
  const pred = cmds.map(() => -1);
  let best = 0;
  for (let i = 0; i < cmds.length; i++) {
    for (let j = 0; j < i; j++) {
      // j can precede i only if it finished at/before i started (the two did not overlap).
      if (cmds[j]._end <= cmds[i]._start && chainMs[j] + cmds[i].durationMs > chainMs[i]) {
        chainMs[i] = chainMs[j] + cmds[i].durationMs;
        pred[i] = j;
      }
    }
    if (chainMs[i] > chainMs[best]) best = i;
  }
  const criticalMs = chainMs[best];
  const onChain = new Set();
  for (let i = best; i >= 0; i = pred[i]) {
    onChain.add(i);
    if (pred[i] < 0) break;
  }

  // Idle / dead-air: wall-clock when nothing ran at all — the makespan minus the union of busy
  // intervals. Large idle means stages left gaps the scheduler never filled.
  const intervals = cmds.map((c) => [c._start, c._end]).sort((a, b) => a[0] - b[0]);
  let covered = 0;
  let curS = intervals[0][0];
  let curE = intervals[0][1];
  for (let k = 1; k < intervals.length; k++) {
    const [s, e] = intervals[k];
    if (s > curE) { covered += curE - curS; curS = s; curE = e; }
    else if (e > curE) curE = e;
  }
  covered += curE - curS;
  const idle = Math.max(0, makespan - covered);

  const anyMemory = cmds.some((c) => c.memoryKb != null);
  const ganttRow = (c, i) => {
    const offsetPct = ((c._start - runStart) / makespan) * 100;
    const widthPct = Math.max((c.durationMs / makespan) * 100, 0.5);
    const crit = onChain.has(i);
    const cls = c.success === false ? 'failed' : crit ? 'crit' : '';
    const heat = memoryHeat(c.memoryKb, ctx.maxMemory, ctx.heatThresholds);
    const heatCls = heat ? ` mem-${heat}` : '';
    const memTitle = c.memoryKb != null ? ` · ${formatMem(c.memoryKb)}` : '';
    const memChip = anyMemory
      ? `<div class="gantt-mem${heat ? ` mem-${heat}` : ''}">${c.memoryKb != null ? formatMem(c.memoryKb) : '—'}</div>`
      : '';
    const scopeTag = c._section ? `<span class="gantt-scope">${escapeHtml(c._section)}</span> ` : '';
    const labelTitle = `${c.command}${c._section ? ` — ${c._section}` : ''}${c.phase ? ` · ${c.phase}` : ''}`;
    return `<div class="gantt-row"><div class="gantt-label" title="${escapeHtml(labelTitle)}">${crit ? '★ ' : ''}${scopeTag}${escapeHtml(c.command)}</div>${memChip}<div class="gantt-track"><div class="gantt-bar ${cls}${heatCls}" style="left:${offsetPct.toFixed(2)}%;width:${widthPct.toFixed(2)}%" title="${escapeHtml(labelTitle)} — ${formatMs(c.durationMs)}${memTitle}"><span class="gantt-dur">${formatMs(c.durationMs)}</span></div></div></div>`;
  };

  const pctOf = (v) => Math.round((v / makespan) * 100);
  const idleNote = idle > 0
    ? ` Idle / dead-air ≈ <strong>${formatMs(idle)}</strong> (${pctOf(idle)}% of wall-clock) — time when nothing was running, i.e. gaps between stages.`
    : '';
  const staleNote = droppedStale > 0
    ? ` ${droppedStale} cache-replayed command${droppedStale === 1 ? '' : 's'} from earlier runs excluded.`
    : '';
  const summary =
    '★ marks the observed critical path — the longest chain of commands that ran strictly one after ' +
    `another, across all sections. Wall-clock ≈ <strong>${formatMs(makespan)}</strong>; observed ` +
    `critical path ≈ <strong>${formatMs(criticalMs)}</strong> (${pctOf(criticalMs)}% of wall-clock).` +
    `${idleNote}${staleNote}`;

  return `<details class="foldable"><summary>Overall Critical Path</summary><p class="muted">${summary}</p><div class="gantt">${cmds.map(ganttRow).join('')}</div></details>`;
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
  const failed = hasFailure(section);
  const running = hasRunning(section);
  const inner =
    renderMeta(section.meta) +
    renderPhasesTable(section.phases, ctx) +
    renderGantt(section.commands, section.overallDurationMs, hasPhases, ctx) +
    renderCommandsTable(section.commands, columns, ctx) +
    failFirst(section.sections || []).map((s) => renderSection(s, columns, ctx)).join('');
  // Expand sections that contain a failure or something still running; clean/passing ones collapse
  // to their one-line summary so the reader isn't wading through green. `has-failure`/`has-running`
  // let the "only failures" filter keep them.
  const cls = `section${failed ? ' has-failure' : ''}${running ? ' has-running' : ''}`;
  const openAttr = failed || running ? ' open' : '';
  return `<details class="${cls}"${openAttr}><summary><span class="badge ${st.kind}">${escapeHtml(st.label)}</span> <span class="section-title">${escapeHtml(section.title || 'Section')}</span><span class="section-dur">${dur}</span></summary><div class="section-body">${inner}</div></details>`;
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
/* Duration heat: same green→amber→red scale, relative to the slowest command. */
.bar.dur.dur-low { background: #22c55e; }
.bar.dur.dur-mid { background: #f59e0b; }
.bar.dur.dur-high { background: #ef4444; }
.durval.dur-low { color: #22c55e; }
.durval.dur-mid { color: #f59e0b; }
.durval.dur-high { color: #ef4444; font-weight: 600; }
/* Memory heat: same green→amber→red scale as the Gantt's bar outline. */
.bar.mem.mem-low { background: #22c55e; }
.bar.mem.mem-mid { background: #f59e0b; }
.bar.mem.mem-high { background: #ef4444; }
.memval.mem-low { color: #22c55e; }
.memval.mem-mid { color: #f59e0b; }
.memval.mem-high { color: #ef4444; font-weight: 600; }
/* CPU heat: same green→amber→red scale, relative to the most CPU-hungry command. */
.bar.cpu { background: #06b6d4; }
.bar.cpu.cpu-low { background: #22c55e; }
.bar.cpu.cpu-mid { background: #f59e0b; }
.bar.cpu.cpu-high { background: #ef4444; }
.cpuval.cpu-low { color: #22c55e; }
.cpuval.cpu-mid { color: #f59e0b; }
.cpuval.cpu-high { color: #ef4444; font-weight: 600; }
/* Legend explaining the heat colors + metric columns. */
.legend { background: #2a2a2a; border-radius: 8px; padding: 0.6rem 0.9rem; margin-bottom: 1rem; font-size: 0.82rem; color: #bbb; }
.legend h3 { margin: 0 0 0.4rem; }
.legend .row { display: flex; flex-wrap: wrap; gap: 0.5rem 1.25rem; align-items: center; }
.legend .swatch { display: inline-flex; align-items: center; gap: 0.4rem; }
.legend .chip { width: 14px; height: 14px; border-radius: 3px; display: inline-block; }
.legend .chip.low { background: #22c55e; }
.legend .chip.mid { background: #f59e0b; }
.legend .chip.high { background: #ef4444; }
.legend .note { margin-top: 0.4rem; color: #999; }
.legend code { font-size: 0.85em; }
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
/* Memory heat: an inset ring on the bar (doesn't change layout or overlap neighbours). */
.gantt-bar.mem-low { box-shadow: inset 0 0 0 2px #22c55e; }
.gantt-bar.mem-mid { box-shadow: inset 0 0 0 2px #f59e0b; }
.gantt-bar.mem-high { box-shadow: inset 0 0 0 2px #ef4444; }
.gantt-mem { width: 64px; flex: 0 0 64px; text-align: right; font-family: ui-monospace, monospace; font-size: 0.7rem; color: #888; }
.gantt-mem.mem-low { color: #22c55e; }
.gantt-mem.mem-mid { color: #f59e0b; }
.gantt-mem.mem-high { color: #ef4444; font-weight: 600; }
.gantt-dur { font-size: 0.65rem; color: #0f0f0f; padding: 0 4px; white-space: nowrap; }
.gantt-scope { color: #777; font-size: 0.72rem; }
details.section { background: #232323; border-radius: 8px; margin-bottom: 0.6rem; padding: 0.25rem 0.75rem; }
details.section > summary { cursor: pointer; padding: 0.5rem 0; display: flex; align-items: center; gap: 0.6rem; }
.section-title { font-weight: 600; }
.section-dur { color: #888; font-size: 0.85rem; }
.section-body { padding: 0.25rem 0 0.5rem; }
.meta { display: flex; flex-wrap: wrap; gap: 0.75rem; margin-bottom: 0.5rem; }
.meta-item { font-size: 0.8rem; color: #bbb; }
.meta-k { color: #777; text-transform: uppercase; font-size: 0.7rem; }
/* Failure-first summary block, rendered right under the status cards. */
.failures { background: #2a2a2a; border-radius: 8px; padding: 0.6rem 0.9rem; margin-bottom: 1rem; }
.failures.none { border-left: 4px solid #22c55e; }
.failures h3 { color: #ef4444; margin-top: 0.2rem; }
.failures.none h3 { color: #a0a0a0; }
.failures .count { background: #ef4444; color: #fff; border-radius: 999px; padding: 0.05rem 0.5rem; font-size: 0.75rem; }
.failures table { margin-bottom: 0; }
.allpass { margin: 0.2rem 0; color: #ccc; font-size: 0.9rem; }
/* Filter toggle: hides passing rows and sections. */
.filter-toggle { display: inline-flex; align-items: center; gap: 0.4rem; font-size: 0.85rem; color: #bbb; cursor: pointer; margin-bottom: 0.8rem; }
/* Collapsible perf/legend blocks — collapsed by default so failures stay in view. */
details.foldable { background: #232323; border-radius: 8px; margin-bottom: 0.6rem; padding: 0.25rem 0.75rem; }
details.foldable > summary { cursor: pointer; padding: 0.5rem 0; color: #a0a0a0; font-weight: 600; font-size: 0.95rem; }
details.foldable .legend { margin: 0.3rem 0; }
/* Only-failures view: hide everything green — passing rows, clean sections, and perf foldouts. */
body.failures-only tr.ok, body.failures-only tr.muted { display: none; }
body.failures-only details.section:not(.has-failure):not(.has-running) { display: none; }
body.failures-only .foldable { display: none; }
`;

// Legend explaining the green→amber→red heat scale and what each heat-coded metric column means.
// Only mentions Memory/CPU when those columns are actually present in the document.
function renderLegend(ctx, present) {
  const t = ctx.heatThresholds || DEFAULT_HEAT_THRESHOLDS;
  const mid = Math.round(t.mid * 100);
  const high = Math.round(t.high * 100);
  const hasMem = present.has('memoryKb');
  const hasCpu = present.has('cpuPercent');
  const metrics = ['<strong>Duration</strong> (vs the slowest)'];
  if (hasMem) metrics.push('<strong>Memory</strong> (peak RSS vs the heaviest)');
  if (hasCpu) metrics.push('<strong>CPU</strong> (avg utilisation vs the most CPU-hungry)');
  const metricList =
    metrics.length === 1
      ? metrics[0]
      : `${metrics.slice(0, -1).join(', ')} and ${metrics[metrics.length - 1]}`;
  const cpuNote = hasCpu
    ? '<div class="note">CPU is <strong>average</strong> utilisation: <code>100%</code> = one core busy for the whole command, <code>&gt;100%</code> = multiple cores on average.</div>'
    : '';
  return `<section class="legend"><h3>Legend</h3>
  <div class="row"><span>Heat — share of the run's worst command:</span>
    <span class="swatch"><span class="chip low"></span> low (&lt; ${mid}%)</span>
    <span class="swatch"><span class="chip mid"></span> elevated (≥ ${mid}%)</span>
    <span class="swatch"><span class="chip high"></span> heavy (≥ ${high}%)</span>
  </div>
  <div class="note">The same green→amber→red scale (and bar length) flags ${metricList}, so you can spot which parallel commands are too heavy to overlap.</div>
  ${cpuNote}</section>`;
}

// Failure-first summary rendered directly under the status cards: every command that genuinely
// failed (success === false), flattened across all sections onto one table, each tagged with its
// enclosing section and a direct log link — so the reader lands on the failures without scrolling
// through passing work. When nothing failed, a single green "all passed" line takes its place.
function renderFailures(payload, ctx) {
  const failed = collectCommandsTagged(payload).filter((c) => c.success === false);
  const total = collectCommands(payload).length;
  if (failed.length === 0) {
    return `<section class="failures none"><h3>Failures</h3><p class="allpass"><span class="badge ok">OK</span> All ${total} command${total === 1 ? '' : 's'} passed.</p></section>`;
  }
  const rows = failed
    .map((c) => {
      const st = statusOf(c);
      const section = c._section ? escapeHtml(c._section) : '—';
      const phase = c.phase != null ? escapeHtml(c.phase) : '—';
      const durationMs = c.durationMs != null ? formatMs(c.durationMs) : '—';
      const log = renderCell('logFile', c, ctx);
      return `<tr class="fail"><td><span class="badge ${st.kind}">${escapeHtml(st.label)}</span></td><td>${section}</td><td>${phase}</td><td><code>${escapeHtml(c.command)}</code></td><td>${durationMs}</td><td>${log}</td></tr>`;
    })
    .join('');
  return `<section class="failures"><h3>Failures <span class="count">${failed.length}</span></h3><table><thead><tr><th>Status</th><th>Section</th><th>Phase</th><th>Command</th><th>Duration</th><th>Log</th></tr></thead><tbody>${rows}</tbody></table></section>`;
}

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
    maxCpu: Math.max(0, ...allCommands.map((c) => c.cpuPercent || 0)),
    repoRoot: payload.repoRoot,
    // Heat thresholds travel in the payload so re-rendering a saved JSON (--render) honours them.
    heatThresholds: normalizeHeatThresholds(payload.memoryHeat),
    durationHeatThresholds: normalizeHeatThresholds(payload.durationHeat),
    cpuHeatThresholds: normalizeHeatThresholds(payload.cpuHeat),
  };

  // A run terminated by the user (SIGINT/SIGTERM) is non-success (success===false) but is not a gate
  // failure — surface it as a distinct amber "Interrupted" banner rather than the red "Failed" one.
  // The flag only changes the LABEL/colour; `success` stays false so CI/exit-code gating is unchanged.
  const interrupted = payload.interrupted === true && success === false;
  const top = interrupted ? { kind: 'warn', label: 'Interrupted' } : statusOf({ success });
  const statusLabel =
    success === null ? 'Running…' : interrupted ? 'Interrupted' : success ? 'Success' : 'Failed';

  // Cross-section/cross-phase overall critical path — the true wall-clock picture the per-section,
  // per-phase Gantts (each on their own zeroed timeline) cannot show. Only meaningful when the run
  // spans multiple sections (a monorepo roll-up) or multiple phases; a single flat command list is
  // already fully described by its own Gantt.
  const overallCriticalPath =
    sections.length > 0 || hasTopPhases ? renderOverallCriticalPath(payload, ctx) : '';

  const topBlocks =
    renderPhasesTable(payload.phases, ctx) +
    renderGantt(topCommands, overallDurationMs, hasTopPhases, ctx) +
    (topCommands.length > 0
      ? `<section><h3>Commands</h3>${renderCommandsTable(topCommands, columns, ctx)}</section>`
      : '');

  // Failing sections float to the top so the reader meets failures before passing work.
  const sectionBlocks = failFirst(sections).map((s) => renderSection(s, columns, ctx)).join('');

  // Pass/fail counts for the summary cards, and whether a "only failures" filter is worth offering.
  const passedCount = allCommands.filter((c) => c.success === true).length;
  const failedCount = allCommands.filter((c) => c.success === false).length;
  const anyFailure = failedCount > 0;
  const countsCard = allCommands.length > 0
    ? `<div class="card ${anyFailure ? 'fail' : 'ok'}">
      <div class="label">Checks</div>
      <div class="value">${passedCount} passed${anyFailure ? ` · ${failedCount} failed` : ''}</div>
    </div>`
    : '';
  const sectionsCard = sections.length > 0
    ? `<div class="card">
      <div class="label">Sections</div>
      <div class="value">${sections.length}</div>
    </div>`
    : '';
  // A checkbox that hides everything green (passing rows, passing sections, perf foldouts) so only
  // failures remain on screen. Only offered when there is at least one failure to filter down to.
  const filterToggle = anyFailure
    ? '<label class="filter-toggle"><input type="checkbox" id="only-failures"> Show only failures</label>'
    : '';
  const filterScript = anyFailure
    ? '<script>document.getElementById("only-failures").addEventListener("change",function(e){document.body.classList.toggle("failures-only",e.target.checked);});</script>'
    : '';

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
    ${countsCard}
    ${sectionsCard}
  </div>
  ${filterToggle}
  ${renderFailures(payload, ctx)}
  <details class="foldable legend-fold"><summary>Legend &amp; performance</summary>
  ${renderLegend(ctx, present)}
  ${overallCriticalPath}
  </details>
  ${topBlocks}
  ${sectionBlocks}
  ${filterScript}
</body>
</html>`;
}
