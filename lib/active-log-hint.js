/**
 * @file active-log-hint.js
 * @description During a repo-root workspace fan-out, the root run's own command logs carry only the
 * task-runner's (e.g. Nx) summary output — the real per-command detail lives in each workspace's own
 * scripts-orchestrator logs. This poller periodically points a tailing developer at whichever
 * workspace log changed most recently, so "where is the live output right now?" has an answer while
 * the fan-out is in flight.
 *
 * Workspace discovery reuses the library's own `discoverWorkspaceDirs` (the root package.json
 * `workspaces` field) — the very same set the aggregate rolls up — so there is no second, drifting
 * copy of workspace-layout knowledge to maintain.
 */
import fs from 'fs';
import path from 'path';
import { discoverWorkspaceDirs } from './workspaces.js';

const LOG_SUBDIR = path.join('logs', 'scripts-orchestrator-logs');

// A "detail" log is a per-command log a tailer actually wants. Skip the orchestrator's own
// bookkeeping log and the fan-out command's log (task-runner summary output only) — neither points
// at per-command detail.
function isDetailLog(name) {
  if (!name.endsWith('.log')) return false;
  if (name.startsWith('orchestrator-main')) return false;
  if (/^scripts-orchestrator(-[a-z]+)?:workspaces\.log$/.test(name)) return false;
  return true;
}

function findMostActiveLog(roots) {
  let best = null;
  for (const dir of roots) {
    let entries;
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue; // dir may not exist yet (workspace hasn't started)
    }
    for (const name of entries) {
      if (!isDetailLog(name)) continue;
      const file = path.join(dir, name);
      let stat;
      try {
        stat = fs.statSync(file);
      } catch {
        continue;
      }
      if (!stat.isFile() || stat.size === 0) continue;
      if (!best || stat.mtimeMs > best.mtimeMs) {
        best = { file, mtimeMs: stat.mtimeMs };
      }
    }
  }
  return best;
}

/**
 * Start polling for the most-recently-active workspace detail log, invoking `onHint` whenever the
 * winner changes. Returns a stop function; the interval is unref'd so it never keeps the event loop
 * alive on its own.
 *
 * @param {object} opts
 * @param {string} opts.repoRoot               Absolute repo root (its package.json declares the workspaces).
 * @param {number} [opts.intervalMs=20000]     Poll cadence.
 * @param {(relPath: string, ageSec: number) => void} opts.onHint  Called with the repo-relative path of the
 *                                             newly-most-active log and its age in seconds.
 * @returns {() => void} stop function
 */
export function startActiveLogHint({ repoRoot, intervalMs = 20000, onHint }) {
  let workspaceDirs = [];
  try {
    workspaceDirs = discoverWorkspaceDirs(repoRoot);
  } catch {
    workspaceDirs = [];
  }
  const roots = [
    path.join(repoRoot, LOG_SUBDIR),
    ...workspaceDirs.map((ws) => path.join(ws, LOG_SUBDIR)),
  ];

  let lastFile = null;
  const tick = () => {
    const active = findMostActiveLog(roots);
    if (!active) return;
    const rel = path.relative(repoRoot, active.file);
    if (rel === lastFile) return;
    lastFile = rel;
    const ageSec = Math.max(0, Math.round((Date.now() - active.mtimeMs) / 1000));
    try {
      onHint(rel, ageSec);
    } catch {
      // a misbehaving hint callback must not break the run
    }
  };

  tick();
  const timer = setInterval(tick, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();

  return () => clearInterval(timer);
}
