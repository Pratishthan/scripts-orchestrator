import { Orchestrator } from './orchestrator.js';

const baseConfig = (extra = {}) => ({
  phases: [{ name: 'p', parallel: [{ command: 'build' }] }],
  ...extra,
});

// Build an orchestrator with the in-process aggregate wired, and stub the seams that would
// otherwise spawn processes / touch disk so we can assert the decision logic in isolation.
function makeOrch({ aggregateOptions = {}, periodicHook = null, isRoot = true } = {}) {
  const orch = new Orchestrator(baseConfig());
  orch.aggregateOptions = aggregateOptions;
  orch.periodicHook = periodicHook;
  orch._isRepoRootRun = () => isRoot;
  // Capture aggregate fires instead of writing a report.
  orch._fireAggregateCalls = [];
  orch._fireAggregate = (inProgress) => orch._fireAggregateCalls.push(inProgress);
  return orch;
}

// Minimal call-counter so the suite stays dependency-free (no jest globals under the ESM runner).
function counter() {
  const fn = (...args) => { fn.calls.push(args); };
  fn.calls = [];
  return fn;
}

describe('Orchestrator in-process workspace aggregate', () => {
  test('no aggregate configured: periodic machinery is inert', () => {
    const orch = new Orchestrator(baseConfig());
    const fireSpy = counter();
    orch._firePeriodicTick = fireSpy;
    orch._startPeriodicHook();
    expect(orch._periodicTimer).toBeNull();
    expect(fireSpy.calls).toHaveLength(0);
  });

  test('root run with aggregate: starts cadence with a prompt first roll-up', () => {
    const orch = makeOrch({ isRoot: true });
    const tickSpy = counter();
    orch._firePeriodicTick = tickSpy;
    orch._startPeriodicHook();
    expect(tickSpy.calls).toHaveLength(1); // prompt first roll-up
    expect(orch._periodicTimer).not.toBeNull();
    orch._stopPeriodicHook(); // avoid a dangling interval
    expect(orch._periodicTimer).toBeNull();
  });

  test('fanned-out workspace run with aggregate: no periodic cadence', () => {
    const orch = makeOrch({ isRoot: false });
    const tickSpy = counter();
    orch._firePeriodicTick = tickSpy;
    orch._startPeriodicHook();
    expect(tickSpy.calls).toHaveLength(0);
    expect(orch._periodicTimer).toBeNull();
  });

  test('periodic tick rolls up with auto-detected inProgress (undefined)', () => {
    const orch = makeOrch({ isRoot: true });
    orch._firePeriodicTick();
    expect(orch._fireAggregateCalls).toEqual([undefined]);
  });

  test('final fire on the root run forces a static (inProgress=false) report', () => {
    const orch = makeOrch({ isRoot: true });
    orch._firePeriodicHookFinal();
    expect(orch._fireAggregateCalls).toEqual([false]);
  });

  test('final fire on a workspace run leaves inProgress auto-detected (root still running)', () => {
    const orch = makeOrch({ isRoot: false });
    orch._firePeriodicHookFinal();
    expect(orch._fireAggregateCalls).toEqual([undefined]);
  });

  test('a legacy periodic_hook takes precedence over the in-process aggregate', () => {
    const orch = makeOrch({ isRoot: true, periodicHook: 'echo hi' });
    // With a shell hook configured, the tick must NOT take the in-process path.
    orch._periodicRunning = true; // make the shell path a no-op without spawning
    orch._firePeriodicTick();
    expect(orch._fireAggregateCalls).toEqual([]);
  });
});
