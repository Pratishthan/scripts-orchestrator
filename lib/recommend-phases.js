/**
 * @file recommend-phases.js
 * @description Resource-aware phase recommender (advisory).
 *
 * Reads a results JSON (the same payload the orchestrator writes via `metrics: ['time','memory','cpu']`)
 * and proposes a phase layout that keeps each phase's concurrent peak memory under a per-host
 * budget AND its concurrent CPU demand under the host's core share, while letting long-running
 * steps overlap. It only reports — it does not change how a run is scheduled.
 *
 * Algorithm: First-Fit-Decreasing bin-packing by step duration. Steps are sorted longest-first
 * and each is placed into the earliest phase where adding it keeps Σ(concurrent peak memory) ≤ budget
 * and Σ(concurrent CPU demand) ≤ core share; otherwise a new phase is opened. Long steps seed phases;
 * short steps fill the gaps beneath them, so makespan (Σ of each phase's longest step) stays near the
 * theoretical floor (the single longest step) without oversubscribing RAM or CPU.
 *
 * CPU demand per step is its measured `cpuPercent ÷ 100` ("core-equivalents": 100% = one core busy
 * for the whole step, 581% ≈ ~6 cores). When the CPU metric wasn't collected each step counts as a
 * single core, so the core-share constraint degrades exactly to the old "≤ core-share steps per phase"
 * behaviour. With real CPU data, I/O-bound steps (well under one core) pack denser than that crude
 * model allowed, while genuinely parallel steps can't be stacked into oversubscription.
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
 * `fanout` models the workspace-level parallelism: when N workspaces gate concurrently they share
 * the host, so each gets 1/N of RAM and cores.
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

/** Section title the roll-up uses for the repo-root global checks (vs. a workspace name). */
const GLOBAL_SECTION_TITLE = 'Global quality checks';

/**
 * Normalise either results shape into a flat list of raw command entries.
 *
 * A single-scope results JSON carries a top-level `commands` array — used as-is, no scope tag.
 * A roll-up report (the kind written for a whole npm-workspace monorepo) carries no top-level
 * `commands`; its commands live under `sections[]` (one section per workspace, plus a global-checks
 * section). Those are flattened into one pool, each entry tagged with its originating scope so the
 * recommendation can label steps and keep the observed timeline per-scope while still packing across
 * scopes. When both keys are present `commands` wins, so the flat path is never altered.
 *
 * Returns `{ entries, aggregate, scopeCount, partial }` — `partial` is set when the roll-up is
 * mid-run (`inProgress`) or any included section is flagged as a partial command list.
 */
function flattenCommands(payload) {
  if (Array.isArray(payload?.commands) || !Array.isArray(payload?.sections)) {
    return {
      entries: Array.isArray(payload?.commands) ? payload.commands : [],
      aggregate: false,
      scopeCount: 0,
      partial: false,
    };
  }
  const entries = [];
  let scopeCount = 0;
  let partial = Boolean(payload.inProgress);
  for (const sec of payload.sections) {
    const cmds = Array.isArray(sec?.commands) ? sec.commands : [];
    if (cmds.length === 0) continue; // pending / stale / no-op sections carry no timing data
    scopeCount += 1;
    if (sec?.meta?.note) partial = true; // e.g. "In progress — partial command list"
    const scope = sec.title === GLOBAL_SECTION_TITLE ? 'global' : sec.title;
    for (const c of cmds) entries.push({ ...c, __scope: scope });
  }
  return { entries, aggregate: true, scopeCount, partial };
}

/**
 * Extract the steps that actually ran and were timed. Skipped/disabled commands and untimed
 * entries are excluded — they tell us nothing about contention. `memoryKb` defaults to 0 when the
 * memory metric wasn't collected (the report then warns and packs by core share alone).
 *
 * Accepts either a single-scope results JSON or a whole-monorepo roll-up report (see
 * {@link flattenCommands}). For a roll-up, each step's command and phase are prefixed with its
 * originating scope (e.g. `@app/web: build` / `@app/web › build`) so the report identifies origin and
 * the observed timeline stays per-scope; packing pools every scope's steps onto one host.
 */
export function usableSteps(payload) {
  const { entries } = flattenCommands(payload);
  return entries
    .filter((c) => c && typeof c.durationMs === 'number' && c.durationMs > 0 && !c.skipReason)
    .map((c) => {
      const scope = c.__scope; // undefined on the single-scope path
      const rawPhase = c.phase != null ? c.phase : '(no phase)';
      return {
        command: scope ? `${scope}: ${c.command}` : c.command,
        phase: scope ? `${scope} › ${rawPhase}` : rawPhase,
        durationMs: c.durationMs,
        memoryKb: typeof c.memoryKb === 'number' && c.memoryKb > 0 ? c.memoryKb : 0,
        cpuPercent: typeof c.cpuPercent === 'number' && c.cpuPercent > 0 ? c.cpuPercent : 0,
        ...(scope ? { scope } : {}), // additive, roll-up path only
      };
    });
}

/**
 * A step's CPU demand in core-equivalents (100% = one core). When the CPU metric is absent
 * (`cpuPercent === 0`) the step counts as a single core, so the core-share constraint reduces to the
 * old "≤ core-share concurrent steps per phase" rule.
 */
export function stepCores(step) {
  return step.cpuPercent > 0 ? step.cpuPercent / 100 : 1;
}

/**
 * Group steps by their original phase (first-seen order) and, for each phase, report the
 * concurrent peak memory (Σ of member peaks — conservative, since peaks rarely coincide exactly)
 * and the phase wall-clock (max member duration, because the phase runs them in parallel).
 */
export function observedTimeline(steps, budgetBytes, coreShare = null) {
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
    const concurrentCpuCores = members.reduce((sum, s) => sum + stepCores(s), 0);
    const wallclockMs = Math.max(...members.map((s) => s.durationMs));
    return {
      name,
      steps: members,
      concurrentMemBytes,
      concurrentCpuCores,
      wallclockMs,
      overBudget: concurrentMemBytes > budgetBytes,
      overCores: coreShare != null && concurrentCpuCores > coreShare,
    };
  });
}

/**
 * First-Fit-Decreasing bin-packing by duration under two co-constraints: Σ(peak memory) ≤ budget
 * and Σ(CPU demand) ≤ core share. A step too large to fit any existing bin opens a new bin; a single
 * step whose own peak memory or CPU demand alone exceeds a budget still gets its own bin (it can't be
 * split) and is flagged.
 *
 * CPU demand is `cpuPercent ÷ 100` (see {@link stepCores}). With no CPU metric every step counts as one
 * core, so the core-share constraint matches the previous "≤ core-share concurrent steps" behaviour.
 */
export function packPhases(steps, budgetBytes, coreShare) {
  const sorted = [...steps].sort((a, b) => b.durationMs - a.durationMs);
  const bins = [];
  for (const step of sorted) {
    const stepBytes = step.memoryKb * KB;
    const cores = stepCores(step);
    let placed = false;
    for (const bin of bins) {
      if (bin.memBytes + stepBytes <= budgetBytes && bin.cpuCores + cores <= coreShare) {
        bin.steps.push(step);
        bin.memBytes += stepBytes;
        bin.cpuCores += cores;
        placed = true;
        break;
      }
    }
    if (!placed) {
      bins.push({ steps: [step], memBytes: stepBytes, cpuCores: cores });
    }
  }
  for (const bin of bins) {
    bin.wallclockMs = Math.max(...bin.steps.map((s) => s.durationMs));
    bin.exceedsBudget = bin.memBytes > budgetBytes; // only possible for a lone oversized step
    bin.exceedsCores = bin.cpuCores > coreShare; // only possible for a lone CPU-heavy step
  }
  return bins;
}

/**
 * Produce a full recommendation object from a results payload. Pure — all host inputs are taken from
 * `opts` or `os`, so it's testable without a real machine.
 */
export function recommendPhases(payload, opts = {}) {
  const budget = computeBudget(opts);
  const meta = flattenCommands(payload);
  const steps = usableSteps(payload);
  const warnings = [];

  if (steps.length === 0) {
    warnings.push('No completed, timed commands found in the results — nothing to recommend.');
  }
  if (!meta.aggregate && !Array.isArray(payload?.commands)) {
    warnings.push(
      'Input has neither a top-level "commands" array nor "sections" — not a recognised results or roll-up report.',
    );
  }
  if (meta.aggregate && meta.partial) {
    warnings.push(
      'This is a partial, in-progress roll-up — some scopes have not finished yet. The recommendation will sharpen once the run completes.',
    );
  }
  const hasMemory = steps.some((s) => s.memoryKb > 0);
  if (steps.length > 0 && !hasMemory) {
    warnings.push(
      'No memory metrics in the results — re-run with metrics including "memory" for a meaningful budget. Packing falls back to the core-share limit only.',
    );
  }
  const hasCpu = steps.some((s) => s.cpuPercent > 0);
  if (steps.length > 0 && !hasCpu) {
    warnings.push(
      'No CPU metrics in the results — re-run with metrics including "cpu" so the core-share limit reflects real CPU demand. Packing falls back to counting one core per step.',
    );
  }

  const observed = observedTimeline(steps, budget.budgetBytes, budget.coreShare);
  const bins = packPhases(steps, budget.budgetBytes, budget.coreShare);

  const observedMakespanMs = observed.reduce((sum, p) => sum + p.wallclockMs, 0);
  const recommendedMakespanMs = bins.reduce((sum, b) => sum + b.wallclockMs, 0);
  const optimalMakespanMs = steps.length ? Math.max(...steps.map((s) => s.durationMs)) : 0;
  const longestStep = steps.length
    ? steps.reduce((a, b) => (b.durationMs > a.durationMs ? b : a))
    : null;

  const verdict = decideVerdict({
    steps,
    observedMakespanMs,
    recommendedMakespanMs,
    optimalMakespanMs,
    longestStep,
    binCount: bins.length,
  });

  return {
    ...budget,
    aggregate: meta.aggregate,
    scopeCount: meta.aggregate ? meta.scopeCount : 0,
    partial: meta.aggregate && meta.partial,
    steps,
    observed,
    observedMakespanMs,
    recommended: { bins, makespanMs: recommendedMakespanMs },
    optimalMakespanMs,
    verdict,
    warnings,
  };
}

/**
 * Reduce the numbers to a single yes/no answer: "is re-grouping these phases worth it?".
 *
 * Re-grouping helps only when packing meaningfully beats the observed makespan. It cannot beat the
 * single longest step (the theoretical floor), so when one step dominates the makespan the honest
 * answer is "no — splitting that step is the only lever left", not "re-group".
 *
 * Returns `{ worthwhile, savedMs, reason }`. Thresholds are deliberately conservative so the advice
 * stays quiet unless there's a real, non-trivial win.
 */
export function decideVerdict({
  steps,
  observedMakespanMs,
  recommendedMakespanMs,
  optimalMakespanMs,
  longestStep,
  binCount,
}) {
  if (!steps.length) {
    return { worthwhile: false, savedMs: 0, reason: 'No timed steps to analyse.' };
  }

  const savedMs = observedMakespanMs - recommendedMakespanMs;
  const savedFraction = observedMakespanMs > 0 ? savedMs / observedMakespanMs : 0;
  const dominantFraction = observedMakespanMs > 0 ? optimalMakespanMs / observedMakespanMs : 0;

  // A real win: packing trims at least 5% AND at least 5s off the observed makespan.
  const significant = savedMs >= 5000 && savedFraction >= 0.05;
  if (significant) {
    return {
      worthwhile: true,
      savedMs,
      reason:
        `Re-grouping into ${binCount} phase(s) could trim ~${fmtDuration(savedMs)} ` +
        `(${Math.round(savedFraction * 100)}%) off the makespan.`,
    };
  }

  // One step is ≥95% of the makespan: nothing else matters until it's broken up.
  if (dominantFraction >= 0.95 && longestStep) {
    return {
      worthwhile: false,
      savedMs,
      reason:
        `One step ("${longestStep.command}", ${fmtDuration(optimalMakespanMs)}) is ` +
        `~${Math.round(dominantFraction * 100)}% of the makespan, so re-grouping the rest cannot help. ` +
        'To go faster, split that step into smaller commands the orchestrator can schedule separately.',
    };
  }

  return {
    worthwhile: false,
    savedMs,
    reason:
      `The current layout is already within ~${fmtDuration(Math.max(0, savedMs))} of the packed ` +
      'optimum — re-grouping is not worth it.',
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

/** Per-step CPU as a percentage (100% = one core); '—' when the metric wasn't collected. */
export function fmtCpu(cpuPercent) {
  return cpuPercent > 0 ? `${cpuPercent}%` : '—';
}

/** Concurrent CPU demand as core-equivalents, e.g. "5.8 cores". */
export function fmtCores(cores) {
  return `${cores.toFixed(1)} cores`;
}

function stepLine(s) {
  return `      ${fmtDuration(s.durationMs).padStart(8)}  ${fmtMemKb(s.memoryKb).padStart(9)}  ${fmtCpu(s.cpuPercent).padStart(6)}  ${s.command}`;
}

/**
 * Render a recommendation as a human-readable, optionally-colored report.
 */
export function formatRecommendationReport(rec, { sourcePath = null } = {}) {
  const c = chalk;
  const L = [];

  L.push(c.bold('🧮 Scripts-Orchestrator — resource-aware phase recommendation (advisory)'));
  if (sourcePath) L.push(c.dim(`   Source: ${sourcePath}`));
  if (rec.aggregate) {
    L.push(c.dim(`   Aggregated across ${rec.scopeCount} scope(s) — pooled onto one host`));
    if (rec.fanout === 1) {
      L.push(
        c.dim(
          '   Pass --fanout N if N of these scopes really gate concurrently on the same host (each then gets 1/N of the budget).',
        ),
      );
    }
  }
  L.push(
    `   Budget: ${c.yellow(fmtMemKb(rec.budgetBytes / KB))} ` +
      `(RAM ${fmtMemKb(rec.totalMemBytes / KB)} × ${rec.memSafety} ÷ fan-out ${rec.fanout}) · ` +
      `core share: ${c.yellow(String(rec.coreShare))} cores (${rec.cores} cores − 2 ÷ ${rec.fanout})`,
  );

  for (const w of rec.warnings) L.push(c.yellow(`   ⚠ ${w}`));
  if (rec.steps.length === 0) {
    L.push('');
    L.push(`${c.bold('Verdict:')} ${verdictLine(rec.verdict)}`);
    return L.join('\n');
  }

  // Observed timeline
  L.push('');
  L.push(
    c.bold(
      `Observed timeline — ${rec.steps.length} steps · ${rec.observed.length} phase(s) · makespan ${fmtDuration(rec.observedMakespanMs)}`,
    ),
  );
  for (const ph of rec.observed) {
    const flags =
      (ph.overBudget ? c.red('  ⚠ concurrent peak over budget') : '') +
      (ph.overCores ? c.red('  ⚠ concurrent CPU over core share') : '');
    L.push(
      `  ${c.cyan(ph.name)}  ${fmtDuration(ph.wallclockMs)} · ${ph.steps.length} step(s) · Σ peak ${fmtMemKb(ph.concurrentMemBytes / KB)} · Σ CPU ${fmtCores(ph.concurrentCpuCores)}${flags}`,
    );
    for (const s of [...ph.steps].sort((a, b) => b.durationMs - a.durationMs)) L.push(stepLine(s));
  }

  // Recommended layout
  L.push('');
  L.push(
    c.bold(
      `Recommended layout — First-Fit-Decreasing by duration (≤ ${fmtMemKb(rec.budgetBytes / KB)} mem, ≤ ${rec.coreShare} cores)`,
    ),
  );
  rec.recommended.bins.forEach((bin, i) => {
    const flag = bin.exceedsBudget
      ? c.red('  ⚠ lone step exceeds memory budget (cannot split)')
      : bin.exceedsCores
        ? c.red('  ⚠ lone step exceeds core share (cannot split)')
        : '';
    L.push(
      `  ${c.green('phase ' + (i + 1))}  ${fmtDuration(bin.wallclockMs)} · ${bin.steps.length} step(s) · Σ peak ${fmtMemKb(bin.memBytes / KB)} · Σ CPU ${fmtCores(bin.cpuCores)}${flag}`,
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

  // Verdict — the one-line yes/no the reader actually wants.
  L.push('');
  L.push(`${c.bold('Verdict:')} ${verdictLine(rec.verdict)}`);

  L.push('');
  L.push(
    c.dim(
      '  Note: advisory only — peak memory is per-process maxima summed conservatively, CPU demand is the\n' +
        '  whole-step average (instantaneous spikes can exceed it), and packing ignores inter-phase data\n' +
        '  dependencies (e.g. build → post-build checks). Validate against a real run.',
    ),
  );

  return L.join('\n');
}

/** Render the verdict as a colored ✅/❌ one-liner. */
function verdictLine(verdict) {
  if (!verdict) return '';
  return verdict.worthwhile
    ? `${chalk.green('✅ Yes')} — ${verdict.reason}`
    : `${chalk.yellow('❌ No')} — ${verdict.reason}`;
}
