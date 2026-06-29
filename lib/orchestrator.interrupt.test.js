import fs from 'fs';
import os from 'os';
import path from 'path';
import { Orchestrator } from './orchestrator.js';

// These tests pin the interrupt-finalization contract: a run killed by a signal (or memory abort)
// must leave a TERMINAL results JSON (top-level success=false) so the report — and the aggregate's
// inProgress auto-detection — reads the run as ENDED rather than stuck RUNNING. Regression guard for
// the bug where an interrupted run lingered on "running" because the root results kept the in-flight
// success:null sentinel.

function tmpResults() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'so-interrupt-'));
  return { dir, json: path.join(dir, 'results.json') };
}

function makeOrchestrator(jsonResultsPath) {
  const config = [{ command: 'build' }, { command: 'test' }];
  const orch = new Orchestrator(config, null, null, null, false, false, [], jsonResultsPath);
  const noop = () => {};
  orch.logger = new Proxy({}, { get: () => noop });
  return orch;
}

describe('terminal _writePartialResults(true)', () => {
  test('records top-level success=false and does not rewrite the run-state marker', () => {
    const { json } = tmpResults();
    const orch = makeOrchestrator(json);
    orch.startTime = Date.now();
    // A command in flight (started, not finished) → its own success stays null (INTERRUPTED), never
    // a false pass.
    orch.commandStartTimes.set('build', new Date().toISOString());

    let runStateWrites = 0;
    orch._writeRunState = () => { runStateWrites += 1; };

    orch._writePartialResults(true);

    const payload = JSON.parse(fs.readFileSync(json, 'utf8'));
    expect(payload.success).toBe(false); // run is OVER, not running
    const build = payload.commands.find((c) => c.command === 'build');
    expect(build.success).toBeNull(); // in-flight → interrupted, not a pass
    expect(runStateWrites).toBe(0); // terminal write leaves the marker for the caller to clear
  });

  test('non-terminal write keeps the in-progress sentinel (success=null)', () => {
    const { json } = tmpResults();
    const orch = makeOrchestrator(json);
    orch.startTime = Date.now();
    orch.commandStartTimes.set('build', new Date().toISOString());
    orch._writeRunState = () => {};

    orch._writePartialResults(false);

    const payload = JSON.parse(fs.readFileSync(json, 'utf8'));
    expect(payload.success).toBeNull();
  });
});

describe('finalizeInterrupted', () => {
  test('cleans up, writes a terminal result, clears run-state, and forces a static roll-up', async () => {
    const { json } = tmpResults();
    const orch = makeOrchestrator(json);

    const calls = [];
    orch._stopPeriodicHook = () => calls.push('stopPeriodic');
    orch._stopActiveLogHint = () => calls.push('stopActiveLog');
    orch.memoryGovernor.stopWatchdog = () => calls.push('stopWatchdog');
    orch.processManager.cleanup = async () => calls.push('cleanup');
    orch._clearRunState = () => calls.push('clearRunState');
    let aggregateInProgress;
    orch._fireAggregate = (v) => { aggregateInProgress = v; calls.push('fireAggregate'); };
    orch.aggregateOptions = {}; // workspace-aware run → final roll-up fires

    await orch.finalizeInterrupted();

    // Terminal results landed on disk with success=false.
    const payload = JSON.parse(fs.readFileSync(json, 'utf8'));
    expect(payload.success).toBe(false);

    // Marker cleared AFTER the terminal write; roll-up forced static (not auto-detected).
    expect(calls).toContain('cleanup');
    expect(calls).toContain('clearRunState');
    expect(aggregateInProgress).toBe(false);
    // Run-state must be cleared before the roll-up reads it (a lingering marker would re-flag RUNNING).
    expect(calls.indexOf('clearRunState')).toBeLessThan(calls.indexOf('fireAggregate'));
  });

  test('skips the roll-up when no aggregate is configured', async () => {
    const { json } = tmpResults();
    const orch = makeOrchestrator(json);
    orch._stopPeriodicHook = () => {};
    orch._stopActiveLogHint = () => {};
    orch.memoryGovernor.stopWatchdog = () => {};
    orch.processManager.cleanup = async () => {};
    orch._clearRunState = () => {};
    let fired = false;
    orch._fireAggregate = () => { fired = true; };
    orch.aggregateOptions = null;

    await orch.finalizeInterrupted();
    expect(fired).toBe(false);
  });
});
