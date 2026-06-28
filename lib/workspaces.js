/**
 * @file workspaces.js
 * @description First-class npm-workspace support: discover the workspaces declared in a
 * repo's root package.json, then aggregate each workspace's orchestrator results JSON
 * (plus the root run's global-check results) into a single, generic report document that
 * the shared HTML renderer can turn into one roll-up page.
 *
 * The aggregator is intentionally domain-agnostic: it reads only artifacts the library
 * itself writes (per-scope results JSON + the run-state file), so it needs no log scraping
 * and no knowledge of any particular task runner. All path conventions are configurable.
 */

import fs from 'fs';
import path from 'path';
import { renderReportHtml } from './report-html.js';

const DEFAULTS = {
  title: 'Workspaces Quality Report',
  outJson: 'logs/monorepo-quality-report.json',
  outHtml: 'logs/monorepo-quality-report.html',
  runStateFile: 'logs/.scripts-orchestrator-run.json',
  rootResults: 'logs/scripts-orchestrator-logs/scripts-orchestrator-results.json',
  globalResults: 'logs/scripts-orchestrator-logs/scripts-orchestrator-global-results.json',
  workspaceResults: 'logs/scripts-orchestrator-logs/scripts-orchestrator-results.json',
  globalPhase: 'global quality checks',
  workspacePhase: 'workspace quality gates',
  refreshSecs: 5,
  exclude: [],
};

function readJson(absPath) {
  try {
    return JSON.parse(fs.readFileSync(absPath, 'utf8'));
  } catch {
    return null;
  }
}

function statMtimeMs(absPath) {
  try {
    return fs.statSync(absPath).mtimeMs;
  } catch {
    return null;
  }
}

function toMs(iso) {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

function toPosix(p) {
  return p.split(path.sep).join('/');
}

/**
 * Walk up from `startDir` (inclusive) to the nearest ancestor whose package.json declares a
 * non-empty `workspaces` array. Returns that directory, or null if none is found.
 *
 * @param {string} startDir
 * @returns {string | null}
 */
export function findRepoRoot(startDir = process.cwd()) {
  let dir = path.resolve(startDir);
  for (;;) {
    const pkg = readJson(path.join(dir, 'package.json'));
    const ws = pkg?.workspaces;
    const patterns = Array.isArray(ws) ? ws : Array.isArray(ws?.packages) ? ws.packages : null;
    if (patterns && patterns.length > 0) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function workspacePatternsOf(pkg) {
  const ws = pkg?.workspaces;
  if (Array.isArray(ws)) return ws;
  if (Array.isArray(ws?.packages)) return ws.packages;
  return [];
}

/**
 * Resolve the directories of the npm workspaces declared in `repoRoot`'s package.json.
 *
 * Supports the two common glob shapes (`dir/*` and an exact `dir/name`). A trailing `/*`
 * expands to the immediate child directories that contain a package.json. Dot-prefixed
 * directories (e.g. `.template`) are skipped to match npm's own glob behaviour.
 *
 * @param {string} repoRoot
 * @returns {string[]} absolute workspace directories
 */
export function discoverWorkspaceDirs(repoRoot) {
  const pkg = readJson(path.join(repoRoot, 'package.json'));
  const patterns = workspacePatternsOf(pkg);
  const dirs = [];
  const seen = new Set();
  const add = (absDir) => {
    if (seen.has(absDir)) return;
    if (!fs.existsSync(path.join(absDir, 'package.json'))) return;
    seen.add(absDir);
    dirs.push(absDir);
  };

  for (const pattern of patterns) {
    const normalized = pattern.replace(/\/+$/, '');
    if (normalized.endsWith('/*')) {
      const baseDir = path.join(repoRoot, normalized.slice(0, -2));
      let entries;
      try {
        entries = fs.readdirSync(baseDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (entry.name.startsWith('.')) continue; // npm's `*` does not match dotfiles
        add(path.join(baseDir, entry.name));
      }
    } else {
      add(path.join(repoRoot, normalized));
    }
  }
  return dirs.sort();
}

function isNoOpGate(pkgJson) {
  const script = pkgJson?.scripts?.['scripts-orchestrator'];
  if (script == null) return true; // workspace does not participate in the gate
  return /echo\s+["']not applicable["']/i.test(script);
}

/** A results file from a previous run window (older than this run started). */
function isStale(jsonAbs, payload, runStartedAt) {
  if (runStartedAt == null) return false;
  if (payload?.timestamp != null) {
    const ts = Date.parse(payload.timestamp);
    if (!Number.isNaN(ts) && ts < runStartedAt - 2000) return true;
  }
  const mtime = statMtimeMs(jsonAbs);
  if (mtime != null && mtime < runStartedAt) return true;
  return false;
}

/** Re-root a workspace command's logFile (relative to the workspace) onto the repo root. */
function commandsWithRepoRelLogs(commands, relDir) {
  return (commands || []).map((c) => {
    if (!c.logFile) return { ...c };
    return { ...c, logFile: toPosix(path.join(relDir, c.logFile)) };
  });
}

/**
 * Read and merge one workspace's results, supporting several results files per workspace.
 *
 * A workspace's gate may be split across more than one orchestrator process that run
 * concurrently (each writing its own results JSON) so their phases do not serialise behind
 * one another. `workspaceResults` may therefore be a single path or a list of paths; this
 * collapses every present, in-window file into one merged view (commands concatenated,
 * status combined) so the roll-up still shows exactly one section per workspace.
 *
 * Combined status mirrors the single-file semantics: a workspace fails if any of its files
 * failed, is running if any is still running (and none failed), and is OK only when every
 * present file is OK. Files from a previous run window (stale) are ignored when at least one
 * fresh file exists; when every present file is stale the workspace is reported stale (the
 * existing CACHED/STALE classification then applies).
 *
 * @returns {{exists:boolean, stale:boolean, success:(boolean|null|undefined), commands:Array, overallDurationMs:(number|undefined)}}
 */
function readMergedWorkspaceResults(wsDir, workspaceResults, relDir, runStartedAt) {
  const relPaths = Array.isArray(workspaceResults)
    ? workspaceResults
    : [workspaceResults];

  const present = [];
  for (const rel of relPaths) {
    const jsonAbs = path.join(wsDir, rel);
    const payload = readJson(jsonAbs);
    if (payload == null) continue;
    present.push({ payload, stale: isStale(jsonAbs, payload, runStartedAt) });
  }

  const exists = present.length > 0;
  const fresh = present.filter((p) => !p.stale);
  // Every present file predates this run → the whole workspace is stale (CACHED/STALE).
  const stale = exists && fresh.length === 0;

  let success;
  if (fresh.length > 0) {
    if (fresh.some((p) => p.payload?.success === false)) success = false;
    else if (fresh.some((p) => p.payload?.success == null)) success = null;
    else success = true;
  }

  // Pass/fail recorded in the workspace's OWN results, regardless of freshness. Used only to judge
  // whether an all-stale workspace is a trustworthy CACHED pass (see classifyWorkspace): a stale
  // file that says success===true is a cache replay of a passing gate (Nx never caches failures),
  // whereas a stale failed/interrupted file is untrustworthy leftover and stays STALE.
  let lastKnownSuccess;
  if (present.length > 0) {
    if (present.some((p) => p.payload?.success === false)) lastKnownSuccess = false;
    else if (present.some((p) => p.payload?.success == null)) lastKnownSuccess = null;
    else lastKnownSuccess = true;
  }

  // Surface every present file's commands, not just the fresh ones. When a workspace's gate is
  // split across independent fan-out lanes (lite + storybook + playwright), a lane that Nx serves
  // from cache does NOT rewrite its results JSON, so that file's `timestamp` predates this run and
  // reads as "stale" even though it is a valid pass for this run. Previously, dropping every stale
  // file whenever a SIBLING lane ran fresh silently hid the cache-replayed lanes — e.g. the entire
  // lite gate (build/lint/test-ci/coverage/post-build) vanished from the report when only the
  // storybook/playwright lanes executed fresh. Keep the stale (cached) commands too. The
  // workspace's pass/fail and CACHED/STALE/RUNNING classification still derive solely from the
  // FRESH files (`success`/`stale` above): a cached lane can neither fail a fresh pass nor rescue a
  // genuinely-stale (no-fresh-file) workspace from the downstream CACHED/STALE gate — it only
  // contributes its last-known commands. (When no file is fresh, `present` is exactly the old
  // all-stale fallback, so fully-cached / fully-stale workspaces are unchanged.)
  const usable = present;
  const commands = usable.flatMap((p) =>
    commandsWithRepoRelLogs(p.payload?.commands, relDir),
  );
  const durations = usable
    .map((p) => p.payload?.overallDurationMs)
    .filter((d) => typeof d === 'number');
  const overallDurationMs = durations.length > 0 ? Math.max(...durations) : undefined;

  return { exists, stale, success, lastKnownSuccess, commands, overallDurationMs };
}

function classifyWorkspace({ noOp, exists, stale, success, lastKnownSuccess, inProgress, fanoutAnyOk }) {
  if (noOp) return { statusKind: 'muted', statusLabel: 'N/A', state: 'noOp' };
  if (!exists) {
    return inProgress
      ? { statusKind: 'muted', statusLabel: 'PENDING', state: 'pending' }
      : { statusKind: 'muted', statusLabel: '—', state: 'absent' };
  }
  if (stale) {
    if (inProgress) return { statusKind: 'muted', statusLabel: 'PENDING', state: 'pending' };
    // The workspace's own results predate this run (no fresh JSON written), which happens when the
    // task runner replayed its gate from cache. Surface those last-known (cached) results as CACHED
    // — rather than a misleading "no data" STALE — but only when BOTH hold:
    //   1. At least one fan-out lane ran clean this run (`fanoutAnyOk`). This proves the fan-out
    //      machinery actually executed and isn't a no-op or wholesale failure. We deliberately do
    //      NOT require EVERY lane to pass: under `nxBail=false` run-many, a fan-out command's exit
    //      reflects the WORST workspace in the batch, not this one — so one workspace's failing
    //      storybook lane must not bury another workspace's cache-replayed (passing) lite results.
    //   2. This workspace's own last-known result says it passed (`lastKnownSuccess === true`).
    //      Nx only caches successes, so a stale success===true file is a genuine replayed pass; a
    //      stale failed/interrupted file is untrustworthy leftover and stays STALE.
    if (fanoutAnyOk && lastKnownSuccess === true) {
      return { statusKind: 'warn', statusLabel: 'CACHED', state: 'cached' };
    }
    return { statusKind: 'warn', statusLabel: 'STALE', state: 'stale' };
  }
  if (success === null || success === undefined) {
    return inProgress
      ? { statusKind: 'running', statusLabel: 'RUNNING', state: 'running' }
      : { statusKind: 'fail', statusLabel: 'INTERRUPTED', state: 'interrupted' };
  }
  if (success === false) return { statusKind: 'fail', statusLabel: 'FAIL', state: 'fail' };
  return { statusKind: 'ok', statusLabel: 'OK', state: 'ok' };
}

function resolveOptions(options = {}) {
  const repoRoot = path.resolve(options.repoRoot || findRepoRoot() || process.cwd());
  const merged = { ...DEFAULTS, ...options, repoRoot };
  const abs = (p) => (path.isAbsolute(p) ? p : path.join(repoRoot, p));
  return {
    ...merged,
    runStateAbs: abs(merged.runStateFile),
    rootResultsAbs: abs(merged.rootResults),
    globalResultsAbs: abs(merged.globalResults),
    outJsonAbs: abs(merged.outJson),
    outHtmlAbs: abs(merged.outHtml),
  };
}

function collectGlobalCommands(opts, runStartedAt) {
  const root = readJson(opts.rootResultsAbs);
  if (root?.commands && !isStale(opts.rootResultsAbs, root, runStartedAt)) {
    const fromRoot = root.commands.filter((c) => c.phase === opts.globalPhase);
    if (fromRoot.length > 0) return fromRoot;
  }
  const global = readJson(opts.globalResultsAbs);
  if (global?.commands && !isStale(opts.globalResultsAbs, global, runStartedAt)) {
    return global.commands.map((c) => ({ ...c, phase: c.phase ?? opts.globalPhase }));
  }
  return [];
}

/**
 * Build the generic report document aggregating the root run's global checks and every
 * workspace's own orchestrator results.
 *
 * @param {object} [options] see DEFAULTS for the supported keys (all paths repo-root-relative)
 * @returns {object} a renderable report payload ({ title, success, sections, ... })
 */
export function aggregateWorkspacesReport(options = {}) {
  const opts = resolveOptions(options);
  const runState = readJson(opts.runStateAbs);
  const rootJson = readJson(opts.rootResultsAbs);

  // Prefer the run-state file's startedAt (present while the run is in flight). The end-of-run
  // aggregate fires AFTER the orchestrator clears that file, so fall back to deriving the run
  // start from the root results: its `timestamp` is the run's END, so subtract its duration.
  // (Using the raw end timestamp would wrongly flag every workspace JSON — all written before
  // the root run finished — as stale.) With no duration to anchor the window, stay lenient
  // (null) rather than risk false "stale" verdicts on this run's results.
  let runStartedAt = toMs(runState?.startedAt);
  if (runStartedAt == null && rootJson?.timestamp) {
    const endMs = toMs(rootJson.timestamp);
    const durationMs = Number(rootJson.overallDurationMs);
    if (endMs != null && Number.isFinite(durationMs) && durationMs > 0) {
      runStartedAt = endMs - durationMs;
    }
  }

  const inProgress =
    options.inProgress != null
      ? Boolean(options.inProgress)
      : runState != null || rootJson?.success === null;

  const excludeSet = new Set((opts.exclude || []).map((e) => toPosix(e)));

  // Did at least one workspace fan-out lane run clean this run? (Used to recognise cache-replayed
  // workspaces, whose own results JSON predates this run because they were not re-executed — see
  // classifyWorkspace.) The fan-out phase now holds several INDEPENDENT lanes (lite + storybook +
  // playwright), and under `nxBail=false` run-many each lane's exit reflects the worst workspace in
  // the batch — so requiring EVERY lane to pass would let one workspace's failing browser lane bury
  // every other workspace's cache-replayed (passing) results. We therefore ask the weaker, correct
  // question: did the fan-out machinery execute and produce at least one successful lane? When no
  // fan-out phase exists in the root results (e.g. a standalone workspace run) this is false → no
  // cache recovery (a genuinely-stale file stays STALE).
  const fanoutCommands = (rootJson?.commands || []).filter((c) => c.phase === opts.workspacePhase);
  const fanoutAnyOk = fanoutCommands.some((c) => c.success === true);

  // Global quality checks section (commands run by the root orchestrator itself).
  // Classify from the section's OWN commands, not the report-wide inProgress flag: the global
  // checks finish before the workspace fan-out, so they must read OK as soon as they are done —
  // even while other workspaces are still RUNNING in an in-progress snapshot.
  const globalCommands = collectGlobalCommands(opts, runStartedAt);
  const globalFailed = globalCommands.filter((c) => c.success === false).length;
  const globalRunning = globalCommands.some((c) => c.success == null);
  const globalState =
    globalCommands.length === 0
      ? { statusKind: 'muted', statusLabel: 'PENDING', success: null }
      : globalRunning
        ? { statusKind: 'running', statusLabel: 'RUNNING', success: null }
        : globalFailed > 0
          ? { statusKind: 'fail', statusLabel: 'FAIL', success: false }
          : { statusKind: 'ok', statusLabel: 'OK', success: true };
  const sections = [
    {
      title: 'Global quality checks',
      statusKind: globalState.statusKind,
      statusLabel: globalState.statusLabel,
      success: globalState.success,
      commands: globalCommands,
    },
  ];

  // One section per discovered workspace.
  let anyWorkspaceBad = false;
  for (const wsDir of discoverWorkspaceDirs(opts.repoRoot)) {
    const relDir = toPosix(path.relative(opts.repoRoot, wsDir));
    if (excludeSet.has(relDir)) continue;

    const pkg = readJson(path.join(wsDir, 'package.json'));
    if (!pkg) continue;
    const name = pkg.name || relDir;
    const noOp = isNoOpGate(pkg);

    const merged = readMergedWorkspaceResults(
      wsDir,
      opts.workspaceResults,
      relDir,
      runStartedAt,
    );
    const { exists, stale, success, lastKnownSuccess } = merged;

    const st = classifyWorkspace({ noOp, exists, stale, success, lastKnownSuccess, inProgress, fanoutAnyOk });
    if (st.state === 'fail' || st.state === 'interrupted') anyWorkspaceBad = true;

    const showCommands =
      st.state === 'ok' || st.state === 'fail' || st.state === 'cached' || st.state === 'running';
    const commands = showCommands ? merged.commands : [];

    const note =
      commands.length === 0 && st.state === 'pending'
        ? 'Queued — not started yet this run'
        : commands.length === 0 && st.state === 'stale'
          ? 'No results for this run window (stale snapshot)'
          : st.state === 'running' && commands.length > 0
            ? 'In progress — partial command list'
            : null;

    sections.push({
      title: name,
      statusKind: st.statusKind,
      statusLabel: st.statusLabel,
      success:
        st.state === 'ok' || st.state === 'cached'
          ? success ?? true
          : st.state === 'fail'
            ? false
            : null,
      overallDurationMs: showCommands ? merged.overallDurationMs : undefined,
      meta: { path: relDir, ...(note ? { note } : {}) },
      commands,
    });
  }

  const rootOk = rootJson ? rootJson.success !== false : true;
  const success = inProgress ? null : rootOk && globalFailed === 0 && !anyWorkspaceBad;

  const overallDurationMs =
    inProgress && runStartedAt != null
      ? Math.max(0, Date.now() - runStartedAt)
      : rootJson?.overallDurationMs;

  return {
    title: opts.title,
    success,
    timestamp: new Date().toISOString(),
    overallDurationMs,
    inProgress,
    repoRoot: toPosix(opts.repoRoot),
    sections,
    // Stamp the run's true workspace fan-out (how many workspace gates execute concurrently) into the
    // report so the `--recommend` packer budgets against the real per-host share instead of guessing
    // (it otherwise falls back to the scope count). Only emitted when a valid value is supplied.
    ...(Number(opts.fanout) >= 1 ? { fanout: Math.max(1, Math.floor(Number(opts.fanout))) } : {}),
    // Carry heat thresholds into the aggregate payload so the renderer honours them.
    ...(opts.memoryHeat ? { memoryHeat: opts.memoryHeat } : {}),
    ...(opts.durationHeat ? { durationHeat: opts.durationHeat } : {}),
  };
}

/** Insert a meta-refresh so an open browser tab live-reloads while the run is in flight. */
function injectAutoRefresh(html, refreshSecs) {
  if (html.includes('http-equiv="refresh"')) return html;
  const meta = `  <meta http-equiv="refresh" content="${refreshSecs}">\n`;
  return html.replace(/(<meta charset="utf-8">\n)/, `$1${meta}`);
}

function atomicWrite(absPath, content) {
  const tmp = `${absPath}.tmp`;
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, absPath);
}

/**
 * Build the aggregate report and write both the JSON document and the rendered HTML.
 *
 * @param {object} [options]
 * @returns {{ payload: object, jsonPath: string, htmlPath: string }}
 */
export function writeAggregateReport(options = {}) {
  const opts = resolveOptions(options);
  const payload = aggregateWorkspacesReport(options);

  atomicWrite(opts.outJsonAbs, JSON.stringify(payload, null, 2));

  let html = renderReportHtml(payload);
  if (payload.inProgress) html = injectAutoRefresh(html, opts.refreshSecs);
  atomicWrite(opts.outHtmlAbs, html);

  return { payload, jsonPath: opts.outJsonAbs, htmlPath: opts.outHtmlAbs };
}
