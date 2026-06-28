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

  test('stamps a supplied fan-out into the payload (so --recommend reads it)', () => {
    rootResults([{ command: 'lint', phase: 'global quality checks', success: true }]);
    const report = aggregateWorkspacesReport({ repoRoot, fanout: 3 });
    expect(report.fanout).toBe(3);
  });

  test('omits fan-out when none is supplied (or it is invalid)', () => {
    rootResults([{ command: 'lint', phase: 'global quality checks', success: true }]);
    expect(aggregateWorkspacesReport({ repoRoot })).not.toHaveProperty('fanout');
    expect(aggregateWorkspacesReport({ repoRoot, fanout: 0 })).not.toHaveProperty('fanout');
  });

  test('merges several results files per workspace into one section', () => {
    // A workspace gate split across concurrent orchestrator processes, each writing its own
    // results file, must still roll up as a single section with every file's commands.
    rootResults([{ command: 'lint', phase: 'global quality checks', success: true }]);
    makeWorkspace('apps/web', {
      results: {
        success: true,
        timestamp: fresh(),
        commands: [{ command: 'test-ci', phase: 'tests', success: true }],
      },
    });
    // Second file (e.g. a browser gate) alongside the default one.
    writeJson(
      path.join(repoRoot, 'apps/web/logs/scripts-orchestrator-logs/scripts-orchestrator-browser-results.json'),
      {
        success: true,
        timestamp: fresh(),
        commands: [{ command: 'storybook tests', phase: 'storybook tests', success: true }],
      },
    );

    const report = aggregateWorkspacesReport({
      repoRoot,
      workspaceResults: [
        'logs/scripts-orchestrator-logs/scripts-orchestrator-results.json',
        'logs/scripts-orchestrator-logs/scripts-orchestrator-browser-results.json',
      ],
    });
    const web = report.sections.find((s) => s.title === 'apps/web');
    expect(web.statusLabel).toBe('OK');
    expect(web.commands.map((c) => c.command)).toEqual(['test-ci', 'storybook tests']);
    expect(report.success).toBe(true);
  });

  test('a failure in any one of a workspace\'s results files fails the section', () => {
    rootResults([{ command: 'lint', phase: 'global quality checks', success: true }]);
    makeWorkspace('apps/web', {
      results: { success: true, timestamp: fresh(), commands: [{ command: 'test-ci', success: true }] },
    });
    writeJson(
      path.join(repoRoot, 'apps/web/logs/scripts-orchestrator-logs/scripts-orchestrator-browser-results.json'),
      { success: false, timestamp: fresh(), commands: [{ command: 'playwright', success: false }] },
    );

    const report = aggregateWorkspacesReport({
      repoRoot,
      workspaceResults: [
        'logs/scripts-orchestrator-logs/scripts-orchestrator-results.json',
        'logs/scripts-orchestrator-logs/scripts-orchestrator-browser-results.json',
      ],
    });
    const web = report.sections.find((s) => s.title === 'apps/web');
    expect(web.statusLabel).toBe('FAIL');
    expect(report.success).toBe(false);
  });

  test('a cache-replayed (stale) lane is still surfaced alongside a fresh sibling lane', () => {
    // Regression: when one lane runs fresh (e.g. storybook/playwright) and another is served from
    // Nx cache (its JSON predates this run, so it reads as stale-by-timestamp), the cached lane's
    // commands must NOT be dropped. Before this fix the entire lite gate (build/lint/test-ci/
    // coverage/post-build) vanished from the report whenever only the browser lanes ran fresh.
    rootResults([
      { command: 'lint', phase: 'global quality checks', success: true },
      { command: 'fan-out', phase: 'workspace quality gates', success: false },
    ]);
    // Lite lane: cache replay → JSON predates this run (stale by timestamp) but is a valid pass.
    makeWorkspace('apps/web', {
      results: {
        success: true,
        timestamp: old(600),
        commands: [{ command: 'test-ci', phase: 'tests', success: true }],
      },
    });
    // Browser lane: ran fresh this run and failed.
    writeJson(
      path.join(repoRoot, 'apps/web/logs/scripts-orchestrator-logs/scripts-orchestrator-browser-results.json'),
      {
        success: false,
        timestamp: fresh(),
        commands: [{ command: 'playwright', phase: 'playwright tests', success: false }],
      },
    );

    const report = aggregateWorkspacesReport({
      repoRoot,
      workspaceResults: [
        'logs/scripts-orchestrator-logs/scripts-orchestrator-results.json',
        'logs/scripts-orchestrator-logs/scripts-orchestrator-browser-results.json',
      ],
    });
    const web = report.sections.find((s) => s.title === 'apps/web');
    // Section status comes from the fresh lane (it failed) ...
    expect(web.statusLabel).toBe('FAIL');
    // ... but the cache-replayed lite lane's commands are still surfaced.
    expect(web.commands.map((c) => c.command)).toEqual(['test-ci', 'playwright']);
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
    expect(global.statusLabel).toBe('FAIL');
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
    const web = report.sections.find((s) => s.title === 'apps/web');
    expect(web.statusLabel).toBe('RUNNING');
    expect(web.commands).toHaveLength(1);
    expect(web.commands[0].command).toBe('test');
    expect(web.meta.note).toMatch(/partial command list/i);
    expect(report.sections.find((s) => s.title === 'packages/a').statusLabel).toBe('PENDING');
  });

  test('global checks read OK as soon as they finish, even mid-run while a workspace is RUNNING', () => {
    markRunning();
    rootResults([{ command: 'lint', phase: 'global quality checks', success: true }], null);
    makeWorkspace('apps/web', {
      results: { success: null, timestamp: fresh(), commands: [{ command: 'test', success: null }] },
    });

    const report = aggregateWorkspacesReport({ repoRoot });
    expect(report.inProgress).toBe(true);
    const global = report.sections.find((s) => s.title === 'Global quality checks');
    expect(global.statusLabel).toBe('OK');
    expect(global.success).toBe(true);
  });

  test('global section is RUNNING while one of its own commands is still in flight', () => {
    markRunning();
    rootResults(
      [
        { command: 'lint', phase: 'global quality checks', success: true },
        { command: 'i18n', phase: 'global quality checks', success: null, startedAt: fresh() },
      ],
      null,
    );
    makeWorkspace('apps/web'); // no results yet

    const report = aggregateWorkspacesReport({ repoRoot });
    const global = report.sections.find((s) => s.title === 'Global quality checks');
    expect(global.statusLabel).toBe('RUNNING');
    expect(global.success).toBeNull();
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

  test('a wholly-failed fan-out (no lane passed) does not turn stale workspaces into CACHED', () => {
    // When NOT ONE fan-out lane ran clean, the fan-out machinery can't be trusted to have replayed
    // anything, so a stale workspace stays STALE rather than surfacing as a cache "pass".
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

  test('cache replay: an all-cached workspace stays CACHED when only a SIBLING fan-out lane fails', () => {
    // Three independent fan-out lanes (lite + storybook + playwright). The lite lane passed; the
    // browser lanes failed — but because of a DIFFERENT workspace (under nxBail=false run-many a
    // lane's exit reflects the worst workspace, not this one). A workspace served entirely from the
    // lite cache must still read CACHED: its own results say pass, and at least one lane ran clean.
    writeJson(
      path.join(repoRoot, 'logs/scripts-orchestrator-logs/scripts-orchestrator-results.json'),
      {
        success: false,
        timestamp: fresh(5),
        overallDurationMs: 1234,
        commands: [
          { command: 'lite fan-out', phase: 'workspace quality gates', success: true },
          { command: 'storybook fan-out', phase: 'workspace quality gates', success: false },
          { command: 'playwright fan-out', phase: 'workspace quality gates', success: false },
        ],
      },
    );
    makeWorkspace('packages/shared', {
      results: { success: true, timestamp: old(600), commands: [{ command: 'test-ci', success: true }] },
    });

    const report = aggregateWorkspacesReport({ repoRoot });
    const shared = report.sections.find((s) => s.title === 'packages/shared');
    expect(shared.statusLabel).toBe('CACHED');
    expect(shared.commands).toHaveLength(1);
    expect(shared.success).toBe(true);
  });

  test('a stale failed/interrupted file is not rescued as CACHED even with a clean fan-out lane', () => {
    // Nx only caches successes — a stale file that says success:false is untrustworthy leftover, so
    // it stays STALE even though a fan-out lane passed.
    writeJson(
      path.join(repoRoot, 'logs/scripts-orchestrator-logs/scripts-orchestrator-results.json'),
      {
        success: true,
        timestamp: fresh(5),
        overallDurationMs: 1234,
        commands: [{ command: 'lite fan-out', phase: 'workspace quality gates', success: true }],
      },
    );
    makeWorkspace('apps/web', {
      results: { success: false, timestamp: old(600), commands: [{ command: 'test', success: false }] },
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
