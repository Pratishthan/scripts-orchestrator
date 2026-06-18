/**
 * @file recommend-phases.js
 * @description R12 — memory-aware phase recommender (advisory).
 *
 * Reads a results JSON (the same payload the orchestrator writes via `metrics: ['time','memory']`)
 * and proposes a phase layout that keeps each phase's concurrent peak memory under a per-host
 * budget while letting long-running steps overlap. This is the "advisory" first step of R12:
 * it only reports — it does not change how a run is scheduled.
 *
 * Algorithm: First-Fit-Decreasing bin-packing by step duration. Steps are sorted longest-first
 * and each is placed into the earliest phase where adding it keeps Σ(concurrent peak memory) ≤ budget
 * and concurrent step count ≤ core share; otherwise a new phase is opened. Long steps seed phases;
 * short steps fill the gaps beneath them, so makespan (Σ of each phase's longest step) stays near the
 * theoretical floor (the single longest step) without oversubscribing RAM.
 */

import os from 'os';
import chalk from 'chalk';

const KB = 1024;
const GB = 1024 * 1024 * 1024;

/**
 * Resolve the per-host scheduling budget.
 *
 * budget = totalmem × memSafety ÷ fanout   (overridable wholesale via budgetMb)
 * coreShare = (cores − 2) ÷ fanout         (≥ 1)
 *
 * `fanout` models the workspace-level parallelism (R1's `--parallel=N`): when N workspaces gate
 * concurrently they share the host, so each gets 1/N of RAM and cores.
 */
export function computeBudget(opts = {}) {
  const totalMemBytes = opts.totalMemBytes != null ? Number(opts.totalMemBytes) : os.totalmem();
  const cores = opts.cores != null ? Number(opts.cores) : os.cpus().length;
  const fanout = Math.max(1, Number(opts.fanout) || 1);
  const memSafety = opts.memSafety != null ? Number(opts.memSafety) : 0.8;
  const budgetBytes =
    opts.budgetMb != null
      ? Number(opts.budgetMb) * 1024 * 1024
      : (totalMemBytes * memSafety) / fanout;
  const coreShare = Math.max(1, Math.floor((cores - 2) / fanout));
  return { totalMemBytes, cores, fanout, memSafety, budgetBytes, coreShare };
}

/**
 * Extract the steps that actually ran and were timed. Skipped/disabled commands and untimed
 * entries are excluded — they tell us nothing about contention. `memoryKb` defaults to 0 when the
 * memory metric wasn't collected (the report then warns and packs by core share alone).
 */
export function usableSteps(payload) {
  const commands = Array.isArray(payload?.commands) ? payload.commands : [];
  return commands
    .filter((c) => c && typeof c.durationMs === 'number' && c.durationMs > 0 && !c.skipReason)
    .map((c) => ({
      command: c.command,
      phase: c.phase != null ? c.phase : '(no phase)',
      durationMs: c.durationMs,
      memoryKb: typeof c.memoryKb === 'number' && c.memoryKb > 0 ? c.memoryKb : 0,
    }));
}

/**
 * Group steps by their original phase (first-seen order) and, for each phase, report the
 * concurrent peak memory (Σ of member peaks — conservative, since peaks rarely coincide exactly)
 * and the phase wall-clock (max member duration, because the phase runs them in parallel).
 */
export function observedTimeline(steps, budgetBytes) {
  const order = [];
  const byPhase = new Map();
  for (const s of steps) {
    if (!byPhase.has(s.phase)) {
      byPhase.set(s.phase, []);
      order.push(s.phase);
    }
    byPhase.get(s.phase).push(s);
  }
  return order.map((name) => {
    const members = byPhase.get(name);
    const concurrentMemBytes = members.reduce((sum, s) => sum + s.memoryKb * KB, 0);
    const wallclockMs = Math.max(...members.map((s) => s.durationMs));
    return {
      name,
      steps: members,
      concurrentMemBytes,
      wallclockMs,
      overBudget: concurrentMemBytes > budgetBytes,
    };
  });
}

/**
 * First-Fit-Decreasing bin-packing by duration. A step too large to fit any existing bin under the
 * budget opens a new bin; a single step whose own peak exceeds the budget still gets its own bin
 * (it can't be split) and is flagged.
 */
export function packPhases(steps, budgetBytes, coreShare) {
  const sorted = [...steps].sort((a, b) => b.durationMs - a.durationMs);
  const bins = [];
  for (const step of sorted) {
    const stepBytes = step.memoryKb * KB;
    let placed = false;
    for (const bin of bins) {
      if (bin.memBytes + stepBytes <= budgetBytes && bin.steps.length < coreShare) {
        bin.steps.push(step);
        bin.memBytes += stepBytes;
        placed = true;
        break;
      }
    }
    if (!placed) {
      bins.push({ steps: [step], memBytes: stepBytes });
    }
  }
  for (const bin of bins) {
    bin.wallclockMs = Math.max(...bin.steps.map((s) => s.durationMs));
    bin.exceedsBudget = bin.memBytes > budgetBytes; // only possible for a lone oversized step
  }
  return bins;
}

/**
 * Produce a full recommendation object from a results payload. Pure — all host inputs are taken from
 * `opts` or `os`, so it's testable without a real machine.
 */
export function recommendPhases(payload, opts = {}) {
  const budget = computeBudget(opts);
  const steps = usableSteps(payload);
  const warnings = [];

  if (steps.length === 0) {
    warnings.push('No completed, timed commands found in the results — nothing to recommend.');
  }
  const hasMemory = steps.some((s) => s.memoryKb > 0);
  if (steps.length > 0 && !hasMemory) {
    warnings.push(
      'No memory metrics in the results — re-run with metrics including "memory" for a meaningful budget. Packing falls back to the core-share limit only.',
    );
  }

  const observed = observedTimeline(steps, budget.budgetBytes);
  const bins = packPhases(steps, budget.budgetBytes, budget.coreShare);

  const observedMakespanMs = observed.reduce((sum, p) => sum + p.wallclockMs, 0);
  const recommendedMakespanMs = bins.reduce((sum, b) => sum + b.wallclockMs, 0);
  const optimalMakespanMs = steps.length ? Math.max(...steps.map((s) => s.durationMs)) : 0;

  return {
    ...budget,
    steps,
    observed,
    observedMakespanMs,
    recommended: { bins, makespanMs: recommendedMakespanMs },
    optimalMakespanMs,
    warnings,
  };
}

// ---- formatting helpers ---------------------------------------------------

export function fmtDuration(ms) {
  if (ms == null) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const rem = Math.round(seconds % 60);
  return `${minutes}m ${rem}s`;
}

export function fmtMemKb(kb) {
  if (!kb) return '0';
  const bytes = kb * KB;
  if (bytes >= GB) return `${(bytes / GB).toFixed(2)} GB`;
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

function stepLine(s) {
  return `      ${fmtDuration(s.durationMs).padStart(8)}  ${fmtMemKb(s.memoryKb).padStart(9)}  ${s.command}`;
}

/**
 * Render a recommendation as a human-readable, optionally-colored report.
 */
export function formatRecommendationReport(rec, { sourcePath = null } = {}) {
  const c = chalk;
  const L = [];

  L.push(c.bold('🧮 Scripts-Orchestrator — memory-aware phase recommendation (R12, advisory)'));
  if (sourcePath) L.push(c.dim(`   Source: ${sourcePath}`));
  L.push(
    `   Budget: ${c.yellow(fmtMemKb(rec.budgetBytes / KB))} ` +
      `(RAM ${fmtMemKb(rec.totalMemBytes / KB)} × ${rec.memSafety} ÷ fan-out ${rec.fanout}) · ` +
      `core share: ${c.yellow(String(rec.coreShare))} (${rec.cores} cores − 2 ÷ ${rec.fanout})`,
  );

  for (const w of rec.warnings) L.push(c.yellow(`   ⚠ ${w}`));
  if (rec.steps.length === 0) return L.join('\n');

  // Observed timeline
  L.push('');
  L.push(
    c.bold(
      `Observed timeline — ${rec.steps.length} steps · ${rec.observed.length} phase(s) · makespan ${fmtDuration(rec.observedMakespanMs)}`,
    ),
  );
  for (const ph of rec.observed) {
    const flag = ph.overBudget ? c.red('  ⚠ concurrent peak over budget') : '';
    L.push(
      `  ${c.cyan(ph.name)}  ${fmtDuration(ph.wallclockMs)} · ${ph.steps.length} step(s) · Σ peak ${fmtMemKb(ph.concurrentMemBytes / KB)}${flag}`,
    );
    for (const s of [...ph.steps].sort((a, b) => b.durationMs - a.durationMs)) L.push(stepLine(s));
  }

  // Recommended layout
  L.push('');
  L.push(
    c.bold(
      `Recommended layout — First-Fit-Decreasing by duration (≤ ${fmtMemKb(rec.budgetBytes / KB)} mem, ≤ ${rec.coreShare} concurrent)`,
    ),
  );
  rec.recommended.bins.forEach((bin, i) => {
    const flag = bin.exceedsBudget ? c.red('  ⚠ lone step exceeds budget (cannot split)') : '';
    L.push(
      `  ${c.green('phase ' + (i + 1))}  ${fmtDuration(bin.wallclockMs)} · ${bin.steps.length} step(s) · Σ peak ${fmtMemKb(bin.memBytes / KB)}${flag}`,
    );
    for (const s of [...bin.steps].sort((a, b) => b.durationMs - a.durationMs)) L.push(stepLine(s));
  });

  // Summary
  const saved = rec.observedMakespanMs - rec.recommended.makespanMs;
  L.push('');
  L.push(c.bold('Estimated makespan'));
  L.push(`  observed (sequential phases): ${fmtDuration(rec.observedMakespanMs)}`);
  const delta =
    saved > 0
      ? c.green(`(−${fmtDuration(saved)})`)
      : saved < 0
        ? c.red(`(+${fmtDuration(-saved)})`)
        : c.dim('(no change)');
  L.push(`  recommended (packed):         ${fmtDuration(rec.recommended.makespanMs)}  ${delta}`);
  L.push(`  theoretical floor (∞ RAM):    ${fmtDuration(rec.optimalMakespanMs)}`);
  L.push('');
  L.push(
    c.dim(
      '  Note: advisory only — peaks are per-process maxima summed conservatively, and packing ignores\n' +
        '  inter-phase data dependencies (e.g. build → post-build checks). Validate against a real run.',
    ),
  );

  return L.join('\n');
}
