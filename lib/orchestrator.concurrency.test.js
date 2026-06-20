import os from 'os';
import { Orchestrator } from './orchestrator.js';

const baseConfig = (extra = {}) => ({
  phases: [{ name: 'p', parallel: [{ command: 'build' }] }],
  ...extra,
});

const cpuAuto = () => Math.max(1, os.cpus().length - 1);

describe('Orchestrator max concurrency resolution', () => {
  test('defaults to auto (cpuCount - 1) when nothing is configured', () => {
    const orch = new Orchestrator(baseConfig());
    expect(orch.maxConcurrency).toBe(cpuAuto());
  });

  test('config max_concurrency: \'auto\' resolves to cpuCount - 1', () => {
    const orch = new Orchestrator(baseConfig({ max_concurrency: 'auto' }));
    expect(orch.maxConcurrency).toBe(cpuAuto());
  });

  test('a positive integer is used verbatim (floored)', () => {
    expect(new Orchestrator(baseConfig({ max_concurrency: 4 })).maxConcurrency).toBe(4);
    expect(new Orchestrator(baseConfig({ max_concurrency: 3.9 })).maxConcurrency).toBe(3);
    expect(new Orchestrator(baseConfig({ max_concurrency: '6' })).maxConcurrency).toBe(6);
  });

  test('zero, negative, and unparseable values fall back to auto', () => {
    expect(new Orchestrator(baseConfig({ max_concurrency: 0 })).maxConcurrency).toBe(cpuAuto());
    expect(new Orchestrator(baseConfig({ max_concurrency: -2 })).maxConcurrency).toBe(cpuAuto());
    expect(new Orchestrator(baseConfig({ max_concurrency: 'lots' })).maxConcurrency).toBe(cpuAuto());
  });

  test('legacy array config still resolves a cap (no max_concurrency key available)', () => {
    const orch = new Orchestrator([{ command: 'a' }, { command: 'b' }]);
    expect(orch.maxConcurrency).toBe(cpuAuto());
  });
});

describe('Orchestrator._runWithConcurrency', () => {
  test('preserves input order in the results array', async () => {
    const orch = new Orchestrator(baseConfig());
    const items = [10, 20, 30, 40];
    const out = await orch._runWithConcurrency(items, 2, async (n) => n * 2);
    expect(out).toEqual([20, 40, 60, 80]);
  });

  test('never exceeds the concurrency limit and still runs every item', async () => {
    const orch = new Orchestrator(baseConfig());
    let inFlight = 0;
    let peak = 0;
    const limit = 3;
    const items = Array.from({ length: 12 }, (_, i) => i);
    const worker = async (i) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      // Yield a couple of microtasks so overlap actually happens.
      await Promise.resolve();
      await Promise.resolve();
      inFlight -= 1;
      return i;
    };
    const out = await orch._runWithConcurrency(items, limit, worker);
    expect(out).toEqual(items);
    expect(peak).toBeLessThanOrEqual(limit);
    expect(peak).toBeGreaterThan(1); // proves it actually parallelised
  });

  test('limit >= item count behaves like Promise.all (all start immediately)', async () => {
    const orch = new Orchestrator(baseConfig());
    let inFlight = 0;
    let peak = 0;
    const items = [1, 2, 3];
    await orch._runWithConcurrency(items, 10, async (n) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await Promise.resolve();
      inFlight -= 1;
      return n;
    });
    expect(peak).toBe(items.length);
  });

  test('empty input resolves to an empty array', async () => {
    const orch = new Orchestrator(baseConfig());
    await expect(orch._runWithConcurrency([], 4, async (n) => n)).resolves.toEqual([]);
  });
});

describe('Orchestrator._phaseConcurrency (per-phase override)', () => {
  test('falls back to the global cap when a phase has no max_concurrency', () => {
    const orch = new Orchestrator(baseConfig({ max_concurrency: 5 }));
    expect(orch._phaseConcurrency({ name: 'p', parallel: [] })).toBe(5);
  });

  test('a phase max_concurrency overrides the global cap (both directions)', () => {
    const orch = new Orchestrator(baseConfig({ max_concurrency: 5 }));
    expect(orch._phaseConcurrency({ name: 'serial', max_concurrency: 1 })).toBe(1);
    expect(orch._phaseConcurrency({ name: 'wider', max_concurrency: 8 })).toBe(8);
  });

  test('a phase\'s \'auto\' resolves to cpuCount - 1 regardless of the global cap', () => {
    const orch = new Orchestrator(baseConfig({ max_concurrency: 1 }));
    expect(orch._phaseConcurrency({ name: 'p', max_concurrency: 'auto' })).toBe(cpuAuto());
  });

  test('an invalid phase value falls back to auto, not to the global cap', () => {
    const orch = new Orchestrator(baseConfig({ max_concurrency: 5 }));
    expect(orch._phaseConcurrency({ name: 'p', max_concurrency: 0 })).toBe(cpuAuto());
    expect(orch._phaseConcurrency({ name: 'p', max_concurrency: 'lots' })).toBe(cpuAuto());
  });
});
