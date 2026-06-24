import { Orchestrator } from './orchestrator.js';

// These tests verify the phase-teardown wiring: that the orchestrator tears down each phase's
// background dependencies (e.g. a `npm run dev` server) at the end of the phase — on both success
// and failure — and threads the phase name + persist flag through to the process manager so it can
// scope that teardown. The process manager is stubbed so nothing real is spawned.

// run() ends in process.exit(); stub it as a no-op recorder so the run resolves normally and the
// test can inspect the exit code(s). A throwing stub would be swallowed by run()'s own try/catch and
// trigger a second cleanup, so we record-and-continue instead (nothing runs after the final exit).
function withMockedExit(fn) {
  const orig = process.exit;
  const codes = [];
  process.exit = (code) => {
    codes.push(code);
  };
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      process.exit = orig;
    })
    .then(() => codes);
}

function makeOrchestrator(config) {
  const orch = new Orchestrator({ memory_guard: false, ...config });
  // Never gate on git state or write artifacts.
  orch.gitCache.shouldSkipExecution = async () => false;
  orch.gitCache.updateCache = async () => {};
  orch._writeRunState = () => {};
  orch._clearRunState = () => {};
  orch._writePartialResults = () => {};
  orch._appendEvent = () => {};
  // Silence this run's own logging (the process manager keeps its own logger).
  const noop = () => {};
  orch.logger = new Proxy({}, { get: () => noop });
  return orch;
}

describe('Orchestrator phase-end background cleanup', () => {
  test('cleanupPhase runs after every executed phase, in order, on success and failure', async () => {
    const config = {
      phases: [
        { name: 'storybook tests', parallel: [{ command: 'ok-1' }] },
        { name: 'playwright tests', parallel: [{ command: 'fails' }] },
        { name: 'after', parallel: [{ command: 'never-runs' }] },
      ],
    };
    const orch = makeOrchestrator(config);

    const cleanupPhaseCalls = [];
    const runEnd = [];
    orch.processManager = {
      setLogFolder() {},
      getLogPath: (c) => `/logs/${c}.log`,
      runCommand: async ({ cmd }) => ({
        success: cmd !== 'fails',
        output: '',
        durationMs: 1,
        memoryKb: null,
        cpuPercent: null,
      }),
      cleanupPhase: async (name) => {
        cleanupPhaseCalls.push(name);
      },
      cleanup: async () => {
        runEnd.push('run-end');
      },
      addBackgroundProcess() {},
    };

    const codes = await withMockedExit(() => orch.run());

    // The two executed phases each tore down; 'after' was cascade-skipped (its phase never ran).
    expect(cleanupPhaseCalls).toEqual(['storybook tests', 'playwright tests']);
    // Run-end cleanup still happens (reclaims any persist:true survivors).
    expect(runEnd).toEqual(['run-end']);
    // A failed phase exits non-zero.
    expect(codes).toContain(1);
  });

  test('executeCommand forwards the phase name and persist flag to runCommand', async () => {
    const orch = makeOrchestrator({ phases: [{ name: 'p', parallel: [] }] });
    let seen = null;
    orch.processManager = {
      getLogPath: (c) => `/logs/${c}.log`,
      runCommand: async (opts) => {
        seen = opts;
        return { success: true, output: '', durationMs: 1, memoryKb: null, cpuPercent: null };
      },
    };

    const ok = await orch.executeCommand(
      { command: 'dev', background: true, persist: true },
      new Set(),
      'playwright tests',
    );

    expect(ok).toBe(true);
    expect(seen.startPhase).toBe('playwright tests');
    expect(seen.persist).toBe(true);
    expect(seen.background).toBe(true);
  });

  test('a background dependency inherits its parent command\'s phase', async () => {
    const orch = makeOrchestrator({ phases: [{ name: 'p', parallel: [] }] });
    const seenByCmd = new Map();
    orch.processManager = {
      getLogPath: (c) => `/logs/${c}.log`,
      runCommand: async (opts) => {
        seenByCmd.set(opts.cmd, opts);
        return { success: true, output: '', durationMs: 1, memoryKb: null, cpuPercent: null };
      },
    };

    await orch.executeCommand(
      {
        command: 'playwright_ci',
        dependencies: [{ command: 'dev', background: true }],
      },
      new Set(),
      'playwright tests',
    );

    // The dependency runs under the same phase as the command that declared it, so its background
    // process is torn down when that phase ends.
    expect(seenByCmd.get('dev').startPhase).toBe('playwright tests');
    expect(seenByCmd.get('playwright_ci').startPhase).toBe('playwright tests');
  });
});
