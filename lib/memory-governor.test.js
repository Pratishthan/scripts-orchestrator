import { MemoryGovernor, resolveMemoryGuard, MEMORY_GUARD_DEFAULTS } from './memory-governor.js';

const silentLogger = { info() {}, warn() {}, error() {}, verbose() {} };

// Build a governor with a controllable free-RAM source and a virtual clock. `sleep` advances the
// clock by the requested amount, so admission loops are deterministic with no real timers. `ratio`
// is either a fixed number or a function of the current virtual time — keyed on time (not call
// count) so it's robust to how many times the implementation reads free RAM per iteration.
const makeGovernor = (opts, { ratio } = {}) => {
  let nowMs = 0;
  const freeRatioFn = () => (typeof ratio === 'function' ? ratio(nowMs) : ratio ?? 1);
  const gov = new MemoryGovernor(opts, {
    logger: silentLogger,
    freeRatioFn,
    now: () => nowMs,
    // setTimeout used only by _sleep here: advance the virtual clock and fire synchronously.
    setTimeoutFn: (fn, ms) => {
      nowMs += ms;
      fn();
      return { unref() {} };
    },
    clearTimeoutFn: () => {},
  });
  return { gov, advance: (ms) => { nowMs += ms; }, now: () => nowMs };
};

describe('resolveMemoryGuard', () => {
  test('false disables the guard but keeps default thresholds', () => {
    const r = resolveMemoryGuard(false);
    expect(r.enabled).toBe(false);
    expect(r.minFreeRatio).toBe(MEMORY_GUARD_DEFAULTS.minFreeRatio);
  });

  test('undefined / null / true all resolve to enabled defaults', () => {
    for (const v of [undefined, null, true]) {
      expect(resolveMemoryGuard(v)).toEqual({ ...MEMORY_GUARD_DEFAULTS });
    }
  });

  test('an object overlays valid fields and keeps enabled unless explicitly false', () => {
    const r = resolveMemoryGuard({ minFreeRatio: 0.25, sustainedMs: 5000 });
    expect(r.enabled).toBe(true);
    expect(r.minFreeRatio).toBe(0.25);
    expect(r.sustainedMs).toBe(5000);
    expect(r.abortFreeRatio).toBe(MEMORY_GUARD_DEFAULTS.abortFreeRatio);
  });

  test('out-of-range numeric fields fall back to defaults (a typo cannot remove protection)', () => {
    const r = resolveMemoryGuard({ minFreeRatio: 2, abortFreeRatio: -1, sustainedMs: 'nope' });
    expect(r.minFreeRatio).toBe(MEMORY_GUARD_DEFAULTS.minFreeRatio);
    expect(r.abortFreeRatio).toBe(MEMORY_GUARD_DEFAULTS.abortFreeRatio);
    expect(r.sustainedMs).toBe(MEMORY_GUARD_DEFAULTS.sustainedMs);
  });

  test('{ enabled: false } overlay keeps the guard off', () => {
    expect(resolveMemoryGuard({ enabled: false }).enabled).toBe(false);
  });
});

describe('MemoryGovernor.waitForHeadroom (admission)', () => {
  test('disabled guard never holds', async () => {
    const { gov } = makeGovernor(false, { ratio: 0.01 });
    const before = Date.now();
    await gov.waitForHeadroom(5);
    expect(Date.now() - before).toBeLessThan(50); // returned immediately, no real timers
  });

  test('healthy memory returns immediately without sleeping (fast path)', async () => {
    const { gov, now } = makeGovernor({ minFreeRatio: 0.15 }, { ratio: 0.9 });
    await gov.waitForHeadroom(3);
    expect(now()).toBe(0); // virtual clock never advanced => no sleep happened
  });

  test('never holds the first/only in-flight command even under pressure', async () => {
    const { gov, now } = makeGovernor({ minFreeRatio: 0.15 }, { ratio: 0.01 });
    await gov.waitForHeadroom(0);
    expect(now()).toBe(0);
  });

  test('holds while memory is low, releases once it recovers above the floor', async () => {
    // free RAM is critically low until t=3000, then recovers above the floor.
    const { gov, now } = makeGovernor(
      { minFreeRatio: 0.15, pollMs: 1000, maxHoldMs: 60000 },
      { ratio: (t) => (t < 3000 ? 0.05 : 0.4) },
    );
    await gov.waitForHeadroom(2);
    expect(now()).toBe(3000); // held through three 1s polls, released at recovery
  });

  test('admits after maxHoldMs when pressure never clears (no deadlock)', async () => {
    const { gov, now } = makeGovernor(
      { minFreeRatio: 0.15, pollMs: 1000, maxHoldMs: 5000 },
      { ratio: 0.01 }, // never recovers
    );
    await gov.waitForHeadroom(2);
    expect(now()).toBeGreaterThanOrEqual(5000);
    // and it doesn't loop forever — bounded near maxHoldMs
    expect(now()).toBeLessThanOrEqual(7000);
  });
});

describe('MemoryGovernor._evaluateAbort (watchdog condition)', () => {
  test('does not abort while free RAM is above the critical floor', () => {
    const { gov } = makeGovernor({ abortFreeRatio: 0.05, sustainedMs: 10000 }, { ratio: 0.5 });
    expect(gov._evaluateAbort(0)).toBe(false);
    expect(gov._evaluateAbort(100000)).toBe(false);
  });

  test('aborts only after free RAM stays below the floor for the sustained window', () => {
    const { gov } = makeGovernor({ abortFreeRatio: 0.05, sustainedMs: 10000 }, { ratio: 0.02 });
    expect(gov._evaluateAbort(0)).toBe(false); // first dip — start the clock
    expect(gov._evaluateAbort(9000)).toBe(false); // still within the window
    expect(gov._evaluateAbort(10000)).toBe(true); // sustained long enough -> abort
  });

  test('a recovery resets the sustained timer (transient spikes do not abort)', () => {
    let ratio = 0.02;
    const gov = new MemoryGovernor(
      { abortFreeRatio: 0.05, sustainedMs: 10000 },
      { logger: silentLogger, freeRatioFn: () => ratio, now: () => 0 },
    );
    expect(gov._evaluateAbort(0)).toBe(false); // dip starts at t=0
    ratio = 0.5;
    expect(gov._evaluateAbort(8000)).toBe(false); // recovered -> timer reset
    ratio = 0.02;
    expect(gov._evaluateAbort(9000)).toBe(false); // new dip starts at t=9000
    expect(gov._evaluateAbort(18000)).toBe(false); // only 9s into the new dip
    expect(gov._evaluateAbort(19000)).toBe(true); // 10s sustained -> abort
  });
});

describe('MemoryGovernor.startWatchdog', () => {
  test('fires onCritical exactly once when memory stays critical', () => {
    // Capture each scheduled sample and a virtual clock we advance by pollMs per tick, so the test
    // can step the watchdog deterministically with no real timers.
    let nowMs = 0;
    let pending = null;
    const gov = new MemoryGovernor(
      { abortFreeRatio: 0.05, sustainedMs: 4000, pollMs: 2000 },
      {
        logger: silentLogger,
        freeRatioFn: () => 0.01, // always critical
        now: () => nowMs,
        setTimeoutFn: (fn) => {
          nowMs += 2000;
          pending = fn;
          return { unref() {} };
        },
        clearTimeoutFn: () => {
          pending = null;
        },
      },
    );

    let calls = 0;
    gov.startWatchdog(() => {
      calls += 1;
    });

    // Step samples until the watchdog either fires or stops re-arming.
    for (let i = 0; i < 10 && pending; i += 1) {
      const fn = pending;
      pending = null;
      fn();
    }

    expect(calls).toBe(1);
    expect(pending).toBeNull(); // did not re-arm after firing
  });

  test('disabled guard never arms the watchdog', () => {
    let armed = false;
    const gov = new MemoryGovernor(false, {
      logger: silentLogger,
      freeRatioFn: () => 0.0,
      setTimeoutFn: () => {
        armed = true;
        return { unref() {} };
      },
    });
    gov.startWatchdog(() => {});
    expect(armed).toBe(false);
  });
});
