import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  findRepoRoot,
  discoverWorkspaceDirs,
  aggregateWorkspacesReport,
  writeAggregateReport,
} from './workspaces.js';

// Anchored in the past so freshly-written fixture files always have an mtime AFTER the run
// started (the staleness check considers both the payload timestamp and the file mtime).
const RUN_STARTED = '2020-01-01T10:00:00.000Z';
const RUN_STARTED_MS = Date.parse(RUN_STARTED);
const fresh = (offsetSec = 10) => new Date(RUN_STARTED_MS + offsetSec * 1000).toISOString();
const old = (offsetSec = 60) => new Date(RUN_STARTED_MS - offsetSec * 1000).toISOString();

let repoRoot;

function writeJson(absPath, obj) {
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, JSON.stringify(obj, null, 2));
}

function makeWorkspace(relDir, { name, orchestratorScript, results } = {}) {
  const wsDir = path.join(repoRoot, relDir);
  writeJson(path.join(wsDir, 'package.json'), {
    name: name ?? relDir,
    scripts:
      orchestratorScript === undefined
        ? { 'scripts-orchestrator': 'run-gate' }
        : orchestratorScript === null
          ? {}
          : { 'scripts-orchestrator': orchestratorScript },
  });
  if (results) {
    writeJson(
      path.join(wsDir, 'logs/scripts-orchestrator-logs/scripts-orchestrator-results.json'),
      results,
    );
  }
}

beforeEach(() => {
  repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'so-ws-'));
  writeJson(path.join(repoRoot, 'package.json'), {
    name: 'root',
    workspaces: ['packages/*', 'apps/*'],
  });
});

afterEach(() => {
  fs.rmSync(repoRoot, { recursive: true, force: true });
});

describe('discoverWorkspaceDirs', () => {
  test('expands dir/* patterns, skips dotdirs and dirs without package.json', () => {
    makeWorkspace('packages/a');
    makeWorkspace('packages/b');
    makeWorkspace('apps/web');
    fs.mkdirSync(path.join(repoRoot, 'packages/.template'), { recursive: true });
    writeJson(path.join(repoRoot, 'packages/.template/package.json'), { name: 't' });
    fs.mkdirSync(path.join(repoRoot, 'packages/no-pkg'), { recursive: true });

    const dirs = discoverWorkspaceDirs(repoRoot).map((d) => path.relative(repoRoot, d));
    expect(dirs).toEqual(['apps/web', 'packages/a', 'packages/b']);
  });
});

describe('findRepoRoot', () => {
  test('walks up to the package.json that declares workspaces', () => {
    makeWorkspace('packages/a');
    const found = findRepoRoot(path.join(repoRoot, 'packages/a'));
    expect(found).toBe(path.resolve(repoRoot));
  });
});

describe('aggregateWorkspacesReport', () => {
  function rootResults(commands, success = true) {
    writeJson(
      path.join(repoRoot, 'logs/scripts-orchestrator-logs/scripts-orchestrator-results.json'),
      { success, timestamp: fresh(5), overallDurationMs: 1234, commands },
    );
  }

  function markRunning() {
    writeJson(path.join(repoRoot, 'logs/.scripts-orchestrator-run.json'), {
      startedAt: RUN_STARTED,
      pid: 123,
    });
  }

  test('classifies ok / fail workspaces and re-roots their log paths', () => {
    rootResults([
      { command: 'lint', phase: 'global quality checks', success: true },
    ]);
    makeWorkspace('apps/web', {
      name: '@app/web',
      results: {
        success: true,
        timestamp: fresh(),
        commands: [{ command: 'test', success: true, logFile: 'logs/scripts-orchestrator-logs/test.log' }],
      },
    });
    makeWorkspace('packages/a', {
      name: '@pkg/a',
      results: {
        success: false,
        timestamp: fresh(),
        commands: [{ command: 'build', success: false }],
      },
    });

    const report = aggregateWorkspacesReport({ repoRoot });
    expect(report.inProgress).toBe(false);
    expect(report.success).toBe(false); // a failing workspace fails the roll-up

    const web = report.sections.find((s) => s.title === '@app/web');
    expect(web.statusLabel).toBe('OK');
    expect(web.commands[0].logFile).toBe('apps/web/logs/scripts-orchestrator-logs/test.log');

    const a = report.sections.find((s) => s.title === '@pkg/a');
    expect(a.statusLabel).toBe('FAIL');
  });

  test('success when every scope passes', () => {
    rootResults([{ command: 'lint', phase: 'global quality checks', success: true }]);
    makeWorkspace('apps/web', {
      results: { success: true, timestamp: fresh(), commands: [] },
    });
    const report = aggregateWorkspacesReport({ repoRoot });
    expect(report.success).toBe(true);
  });

  test('global check failure fails the roll-up', () => {
    rootResults(
      [{ command: 'lint', phase: 'global quality checks', success: false }],
      false,
    );
    makeWorkspace('apps/web', { results: { success: true, timestamp: fresh(), commands: [] } });
    const report = aggregateWorkspacesReport({ repoRoot });
    expect(report.success).toBe(false);
    const global = report.sections.find((s) => s.title === 'Global quality checks');
    expect(global.success).toBe(false);
  });

  test('in-progress run: success:null workspace is RUNNING, missing is PENDING', () => {
    markRunning();
    rootResults([{ command: 'lint', phase: 'global quality checks', success: true }], null);
    makeWorkspace('apps/web', {
      results: { success: null, timestamp: fresh(), commands: [{ command: 'test', success: null }] },
    });
    makeWorkspace('packages/a'); // no results yet

    const report = aggregateWorkspacesReport({ repoRoot });
    expect(report.inProgress).toBe(true);
    expect(report.success).toBeNull();
    expect(report.sections.find((s) => s.title === 'apps/web').statusLabel).toBe('RUNNING');
    expect(report.sections.find((s) => s.title === 'packages/a').statusLabel).toBe('PENDING');
  });

  test('after the run, a success:null results file reads as INTERRUPTED, not running', () => {
    rootResults([{ command: 'lint', phase: 'global quality checks', success: true }]);
    makeWorkspace('apps/web', {
      results: { success: null, timestamp: fresh(), commands: [{ command: 'test', success: null }] },
    });
    const report = aggregateWorkspacesReport({ repoRoot });
    expect(report.inProgress).toBe(false);
    expect(report.sections.find((s) => s.title === 'apps/web').statusLabel).toBe('INTERRUPTED');
    expect(report.success).toBe(false);
  });

  test('end-of-run fire (no run-state): derives run start from root end − duration, not end', () => {
    // The orchestrator clears the run-state file before its final aggregate, and the root
    // results timestamp is the run's END. A workspace that finished mid-run has a timestamp
    // BEFORE that end — it must read OK, not STALE.
    const runStart = RUN_STARTED_MS;
    const runEnd = runStart + 200 * 1000; // 200s run
    writeJson(
      path.join(repoRoot, 'logs/scripts-orchestrator-logs/scripts-orchestrator-results.json'),
      {
        success: true,
        timestamp: new Date(runEnd).toISOString(),
        overallDurationMs: runEnd - runStart,
        commands: [{ command: 'lint', phase: 'global quality checks', success: true }],
      },
    );
    // Workspace finished 60s into the run — before the root end timestamp.
    makeWorkspace('apps/web', {
      results: {
        success: true,
        timestamp: new Date(runStart + 60 * 1000).toISOString(),
        commands: [{ command: 'test', success: true }],
      },
    });

    const report = aggregateWorkspacesReport({ repoRoot });
    expect(report.inProgress).toBe(false);
    expect(report.sections.find((s) => s.title === 'apps/web').statusLabel).toBe('OK');
    expect(report.success).toBe(true);
  });

  test('stale results from a previous run are not counted as this run', () => {
    rootResults([{ command: 'lint', phase: 'global quality checks', success: true }]);
    makeWorkspace('apps/web', {
      results: { success: true, timestamp: old(120), commands: [{ command: 'test', success: true }] },
    });
    const report = aggregateWorkspacesReport({ repoRoot });
    const web = report.sections.find((s) => s.title === 'apps/web');
    expect(web.statusLabel).toBe('STALE');
    expect(web.commands).toHaveLength(0);
  });

  test('cache replay: stale workspace JSON + passing fan-out phase reads as CACHED with commands', () => {
    // Root results carry the workspace fan-out phase (it passed this run) plus globals.
    writeJson(
      path.join(repoRoot, 'logs/scripts-orchestrator-logs/scripts-orchestrator-results.json'),
      {
        success: true,
        timestamp: fresh(5),
        overallDurationMs: 1234,
        commands: [
          { command: 'lint', phase: 'global quality checks', success: true },
          { command: 'fan-out', phase: 'workspace quality gates', success: true },
        ],
      },
    );
    // Workspace results predate this run (cache replay did not re-execute it / rewrite its JSON).
    makeWorkspace('apps/web', {
      results: { success: true, timestamp: old(600), commands: [{ command: 'test', success: true }] },
    });

    const report = aggregateWorkspacesReport({ repoRoot });
    const web = report.sections.find((s) => s.title === 'apps/web');
    expect(web.statusLabel).toBe('CACHED');
    expect(web.commands).toHaveLength(1); // last-known (cached) commands surfaced
    expect(web.success).toBe(true);
    expect(report.success).toBe(true); // cached pass does not fail the roll-up
  });

  test('failed fan-out phase does not turn stale workspaces into CACHED', () => {
    writeJson(
      path.join(repoRoot, 'logs/scripts-orchestrator-logs/scripts-orchestrator-results.json'),
      {
        success: false,
        timestamp: fresh(5),
        overallDurationMs: 1234,
        commands: [{ command: 'fan-out', phase: 'workspace quality gates', success: false }],
      },
    );
    makeWorkspace('apps/web', {
      results: { success: true, timestamp: old(600), commands: [{ command: 'test', success: true }] },
    });
    const report = aggregateWorkspacesReport({ repoRoot });
    expect(report.sections.find((s) => s.title === 'apps/web').statusLabel).toBe('STALE');
  });

  test('a no-op gate (echo "not applicable" or no script) is marked N/A', () => {
    rootResults([{ command: 'lint', phase: 'global quality checks', success: true }]);
    makeWorkspace('apps/web', { orchestratorScript: 'echo "not applicable"' });
    makeWorkspace('packages/a', { orchestratorScript: null });
    const report = aggregateWorkspacesReport({ repoRoot });
    expect(report.sections.find((s) => s.title === 'apps/web').statusLabel).toBe('N/A');
    expect(report.sections.find((s) => s.title === 'packages/a').statusLabel).toBe('N/A');
  });

  test('exclude option drops a workspace from the report', () => {
    rootResults([]);
    makeWorkspace('packages/.ignored-by-glob');
    makeWorkspace('packages/a', { results: { success: true, timestamp: fresh(), commands: [] } });
    const report = aggregateWorkspacesReport({ repoRoot, exclude: ['packages/a'] });
    expect(report.sections.find((s) => s.title === 'packages/a')).toBeUndefined();
  });
});

describe('writeAggregateReport', () => {
  test('writes JSON + HTML and injects auto-refresh only while in progress', () => {
    writeJson(path.join(repoRoot, 'logs/.scripts-orchestrator-run.json'), {
      startedAt: RUN_STARTED,
      pid: 1,
    });
    writeJson(
      path.join(repoRoot, 'logs/scripts-orchestrator-logs/scripts-orchestrator-results.json'),
      { success: null, timestamp: fresh(), commands: [] },
    );
    makeWorkspace('apps/web', { results: { success: true, timestamp: fresh(), commands: [] } });

    const { jsonPath, htmlPath } = writeAggregateReport({ repoRoot, title: 'My Roll-up' });
    expect(fs.existsSync(jsonPath)).toBe(true);
    const html = fs.readFileSync(htmlPath, 'utf8');
    expect(html).toContain('My Roll-up');
    expect(html).toContain('http-equiv="refresh"'); // in progress → live refresh

    // Once finished (no run-state, root results finalized) the refresh meta is gone.
    fs.rmSync(path.join(repoRoot, 'logs/.scripts-orchestrator-run.json'));
    writeJson(
      path.join(repoRoot, 'logs/scripts-orchestrator-logs/scripts-orchestrator-results.json'),
      { success: true, timestamp: fresh(), commands: [] },
    );
    const res = writeAggregateReport({ repoRoot, title: 'My Roll-up' });
    expect(fs.readFileSync(res.htmlPath, 'utf8')).not.toContain('http-equiv="refresh"');
  });
});
