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

// A step is "heavy" when it commands multiple cores (≥ this many core-equivalents — a real fan of
// child processes) or, on its own, occupies a large fraction of the per-host budget. Two heavy steps
// must never share a phase regardless of whether their measured peaks happen to sum under budget.
const HEAVY_CORES = 2;
const HEAVY_MEM_FRACTION = 0.25;

/**
 * A step's CPU-corrected memory weight in KB — the quantity the packer should reserve against, not the
 * bare `memoryKb`.
 *
 * Why: `memoryKb` is the peak RSS of the single wrapped `sh -c "<cmd>"` process (`/usr/bin/time`). For
 * a fan-out command — `nx run test-ci` (a Jest pool of ~7 worker processes, each its own heap),
 * `build:check` (esbuild/vite workers), a multi-GB `tsc` — that parent-only peak under-counts the real
 * working set by roughly the number of busy children. The CPU metric is a direct proxy for that fan: a
 * step averaging 581% CPU ran ~6 cores' worth of concurrent work, so its true footprint is ~6× the
 * measured parent peak. Multiplying by `max(1, stepCores)` scales heavy multi-process steps up to a
 * realistic weight while leaving light / I-O-bound (sub-core) steps at their measured peak.
 *
 * This is the correction that stops `Σ(thin peaks) ≤ budget` from green-lighting a phase whose real
 * concurrent RSS is a multiple of the budget (the failure that drove the host into swap).
 */
export function effectiveMemoryKb(step) {
  return step.memoryKb * Math.max(1, stepCores(step));
}

/** {@link effectiveMemoryKb} expressed in bytes. */
export function effectiveBytes(step) {
  return effectiveMemoryKb(step) * KB;
}

/**
 * Classify a step as "heavy" — one whose fan of children makes it unsafe to co-schedule with another
 * heavy step in the same phase. Encodes the M3 invariant ("never overlap the heavy phases") as a
 * property of the step itself rather than a hand-maintained config rule.
 */
export function isHeavy(step, budgetBytes) {
  if (stepCores(step) >= HEAVY_CORES) return true;
  return budgetBytes > 0 && effectiveBytes(step) >= HEAVY_MEM_FRACTION * budgetBytes;
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
    // Raw Σ of measured peaks (shown in the report) and the CPU-corrected Σ the budget is judged
    // against — the latter reflects each step's real child fan, the former only its wrapper process.
    const concurrentMemBytes = members.reduce((sum, s) => sum + s.memoryKb * KB, 0);
    const concurrentEffBytes = members.reduce((sum, s) => sum + effectiveBytes(s), 0);
    const concurrentCpuCores = members.reduce((sum, s) => sum + stepCores(s), 0);
    const wallclockMs = Math.max(...members.map((s) => s.durationMs));
    return {
      name,
      steps: members,
      concurrentMemBytes,
      concurrentEffBytes,
      concurrentCpuCores,
      wallclockMs,
      overBudget: concurrentEffBytes > budgetBytes,
      overCores: coreShare != null && concurrentCpuCores > coreShare,
    };
  });
}

/**
 * First-Fit-Decreasing bin-packing by duration under three co-constraints:
 *   1. Σ(effective memory) ≤ budget   — effective = CPU-corrected weight (see {@link effectiveMemoryKb}),
 *      so the constraint reflects each step's real child fan, not just its wrapper's peak RSS.
 *   2. Σ(CPU demand) ≤ core share      — `cpuPercent ÷ 100` per step (see {@link stepCores}).
 *   3. At most one "heavy" step per bin — two heavy fans (Jest pool + vite build + tsc …) must never
 *      co-schedule even if their measured peaks happen to sum under budget (the M3 invariant, encoded
 *      via {@link isHeavy}). This is the guard against the under-measured-RSS over-pack that turned
 *      peak RAM from MAX(phase) into SUM(phases) and drove the host into swap.
 *
 * A step too large to fit any existing bin opens a new bin; a single step whose own effective memory or
 * CPU demand alone exceeds a budget still gets its own bin (it can't be split) and is flagged.
 *
 * With no CPU metric every step counts as one core and is not classified heavy on the CPU axis, so the
 * behaviour degrades to the previous "≤ core-share concurrent steps, Σ peak ≤ budget" model.
 */
export function packPhases(steps, budgetBytes, coreShare) {
  const sorted = [...steps].sort((a, b) => b.durationMs - a.durationMs);
  const bins = [];
  for (const step of sorted) {
    const stepBytes = effectiveBytes(step);
    const rawBytes = step.memoryKb * KB;
    const cores = stepCores(step);
    const heavy = isHeavy(step, budgetBytes);
    let placed = false;
    for (const bin of bins) {
      const memOk = bin.memBytes + stepBytes <= budgetBytes;
      const cpuOk = bin.cpuCores + cores <= coreShare;
      const heavyOk = !(heavy && bin.hasHeavy); // M3: never two heavy fans in one phase
      if (memOk && cpuOk && heavyOk) {
        bin.steps.push(step);
        bin.memBytes += stepBytes;
        bin.rawMemBytes += rawBytes;
        bin.cpuCores += cores;
        bin.hasHeavy = bin.hasHeavy || heavy;
        placed = true;
        break;
      }
    }
    if (!placed) {
      bins.push({ steps: [step], memBytes: stepBytes, rawMemBytes: rawBytes, cpuCores: cores, hasHeavy: heavy });
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
 * Resolve the fan-out to budget against, with a fail-safe default. Precedence:
 *   1. An explicit `opts.fanout` (e.g. a `--fanout` flag) — always wins.
 *   2. A fan-out stamped into the report itself (`payload.fanout` / `payload.meta.fanout`) — the
 *      durable fix: the run that produced the report knows its true workspace parallelism and records
 *      it, so the recommender never has to guess.
 *   3. For a multi-scope roll-up with neither of the above: default to the scope count, NOT 1. The
 *      roll-up pools every scope's steps onto one host, so assuming a single gate owns the box (fan-out
 *      1) over-sizes the budget by ~Nx and invites exactly the over-pack that caused the OOM. Erring
 *      toward over-dividing is the safe direction (it can only make the advice more conservative).
 *   4. A single-scope (flat) results file: fan-out 1 — there is genuinely one gate.
 *
 * Returns `{ fanout, source }` where source explains which rule applied (for the warning text).
 */
export function resolveFanout(payload, meta, opts = {}) {
  if (opts.fanout != null && Number(opts.fanout) >= 1) {
    return { fanout: Math.max(1, Math.floor(Number(opts.fanout))), source: 'explicit' };
  }
  const stamped = Number(payload?.fanout ?? payload?.meta?.fanout);
  if (Number.isFinite(stamped) && stamped >= 1) {
    return { fanout: Math.max(1, Math.floor(stamped)), source: 'report' };
  }
  if (meta.aggregate && meta.scopeCount > 1) {
    return { fanout: meta.scopeCount, source: 'scopeCount' };
  }
  return { fanout: 1, source: 'default' };
}

/**
 * Produce a full recommendation object from a results payload. Pure — all host inputs are taken from
 * `opts` or `os`, so it's testable without a real machine.
 */
export function recommendPhases(payload, opts = {}) {
  const meta = flattenCommands(payload);
  // Resolve fan-out BEFORE the budget so a roll-up never silently budgets as if one gate owned the box.
  const { fanout, source: fanoutSource } = resolveFanout(payload, meta, opts);
  const budget = computeBudget({ ...opts, fanout });
  const steps = usableSteps(payload);
  const warnings = [];

  if (steps.length === 0) {
    warnings.push('No completed, timed commands found in the results — nothing to recommend.');
  }
  if (fanoutSource === 'scopeCount') {
    warnings.push(
      `No fan-out supplied for this ${meta.scopeCount}-scope roll-up — assuming fan-out ${fanout} ` +
        '(the scope count) so the budget is divided across the concurrently-gating workspaces. Pass ' +
        '--fanout to override, or stamp the real workspace parallelism into the report.',
    );
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
    fanoutSource,
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
  // Surface the CPU-corrected weight next to the raw peak when they differ (a multi-core step), so the
  // reader can see why a step weighs more for scheduling than its measured RSS suggests.
  const effKb = effectiveMemoryKb(s);
  const effStr =
    effKb > s.memoryKb ? chalk.dim(` (≈${fmtMemKb(effKb)} weighted)`) : '';
  return `      ${fmtDuration(s.durationMs).padStart(8)}  ${fmtMemKb(s.memoryKb).padStart(9)}  ${fmtCpu(s.cpuPercent).padStart(6)}  ${s.command}${effStr}`;
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
    const fanoutNote =
      rec.fanoutSource === 'report'
        ? `   Fan-out ${rec.fanout} read from the report.`
        : rec.fanoutSource === 'scopeCount'
          ? `   Fan-out defaulted to ${rec.fanout} (scope count) — pass --fanout to set the real workspace parallelism.`
          : rec.fanoutSource === 'explicit'
            ? `   Fan-out ${rec.fanout} (from --fanout).`
            : '   Pass --fanout N if N of these scopes really gate concurrently on the same host (each then gets 1/N of the budget).';
    L.push(c.dim(fanoutNote));
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
      (ph.overBudget ? c.red('  ⚠ concurrent weighted memory over budget') : '') +
      (ph.overCores ? c.red('  ⚠ concurrent CPU over core share') : '');
    L.push(
      `  ${c.cyan(ph.name)}  ${fmtDuration(ph.wallclockMs)} · ${ph.steps.length} step(s) · Σ weight ${fmtMemKb(ph.concurrentEffBytes / KB)} (peak ${fmtMemKb(ph.concurrentMemBytes / KB)}) · Σ CPU ${fmtCores(ph.concurrentCpuCores)}${flags}`,
    );
    for (const s of [...ph.steps].sort((a, b) => b.durationMs - a.durationMs)) L.push(stepLine(s));
  }

  // Recommended layout
  L.push('');
  L.push(
    c.bold(
      `Recommended layout — First-Fit-Decreasing by duration (≤ ${fmtMemKb(rec.budgetBytes / KB)} weighted mem, ≤ ${rec.coreShare} cores, ≤ 1 heavy step/phase)`,
    ),
  );
  rec.recommended.bins.forEach((bin, i) => {
    const flag = bin.exceedsBudget
      ? c.red('  ⚠ lone step exceeds memory budget (cannot split)')
      : bin.exceedsCores
        ? c.red('  ⚠ lone step exceeds core share (cannot split)')
        : '';
    L.push(
      `  ${c.green('phase ' + (i + 1))}  ${fmtDuration(bin.wallclockMs)} · ${bin.steps.length} step(s) · Σ weight ${fmtMemKb(bin.memBytes / KB)} (peak ${fmtMemKb(bin.rawMemBytes / KB)}) · Σ CPU ${fmtCores(bin.cpuCores)}${flag}`,
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
      '  Note: advisory only. "weight" is each step\'s measured peak RSS scaled by its CPU core-count to\n' +
        '  approximate the child-process fan the per-process peak misses; "peak" is the raw measured maximum.\n' +
        '  At most one heavy (multi-core) step is placed per phase so two heavy fans never co-schedule. CPU\n' +
        '  demand is the whole-step average (spikes can exceed it), and packing ignores inter-phase data\n' +
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
