import os from 'os';
import { log as defaultLogger } from './logger.js';

/**
 * @file memory-governor.js
 * @description Host-memory safety governor for the orchestrator.
 *
 * The orchestrator's only governor used to be a count-based `max_concurrency`, which bounds how many
 * commands run at once but is blind to how much memory each one (and its hidden fan of child
 * processes) actually weighs. When a phase runs a *heterogeneous* mix of heavy commands — or when a
 * workspace fan-out stacks several such phases on one box — peak RAM becomes a SUM rather than a MAX
 * and the host can be driven into swap, thrashing until it (or the OS OOM-killer) becomes
 * unresponsive. A build tool must never do that: it must throttle, or abort cleanly, before
 * exhausting host memory.
 *
 * This governor adds the two guards a count cap can't provide:
 *
 *   1. Admission control — before dispatching the *next* command in a phase, if free host RAM is
 *      below an admission floor it holds that command in the queue until a running command frees
 *      memory, regardless of how many concurrency slots are free. It never holds the first/only
 *      in-flight command (you can't relieve pressure by waiting on yourself), so the run always
 *      makes progress.
 *
 *   2. A hard abort watchdog — if free RAM stays below a critical floor continuously for a sustained
 *      interval, it fires once so the caller can kill the child process tree and exit non-zero with
 *      a diagnostic, rather than letting the machine swap to death.
 *
 * Both guards read live `os.freemem()/os.totalmem()`. All time/memory sources are injectable so the
 * logic is deterministic under test.
 */

export const MEMORY_GUARD_DEFAULTS = Object.freeze({
  enabled: true,
  // Admission floor: hold the next command while free RAM is below this fraction of total RAM,
  // as long as at least one command is already running. 0.15 == keep ~15% headroom.
  minFreeRatio: 0.15,
  // Critical floor: if free RAM stays below this fraction continuously for `sustainedMs`, the
  // watchdog fires the abort. 0.05 == "< 5% free for a sustained window" (the doc's requirement).
  abortFreeRatio: 0.05,
  // How long free RAM must stay under the critical floor before the watchdog aborts.
  sustainedMs: 15000,
  // Sampling cadence for both the admission re-check and the watchdog.
  pollMs: 2000,
  // Safety valve: never hold a single command in admission longer than this. Memory pressure can be
  // external (another process on the box) and may never clear; rather than deadlock the run we admit
  // with a warning once this elapses.
  maxHoldMs: 120000,
});

const toFraction = (value, fallback) => {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0 || n >= 1) return fallback;
  return n;
};

const toPositiveMs = (value, fallback) => {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return n;
};

/**
 * Resolve a `memory_guard` config value into a concrete options object.
 *   - `false`            -> disabled (all guards off)
 *   - `undefined`/`null`/`true` -> defaults (enabled)
 *   - object             -> defaults with the provided fields overlaid (and sanitised)
 * Unknown / out-of-range numeric fields fall back to their default rather than disabling the guard,
 * so a typo can never silently remove the protection.
 */
export function resolveMemoryGuard(value) {
  if (value === false) return { ...MEMORY_GUARD_DEFAULTS, enabled: false };
  if (value == null || value === true) return { ...MEMORY_GUARD_DEFAULTS };
  if (typeof value !== 'object') return { ...MEMORY_GUARD_DEFAULTS };

  const d = MEMORY_GUARD_DEFAULTS;
  return {
    enabled: value.enabled !== false,
    minFreeRatio: toFraction(value.minFreeRatio, d.minFreeRatio),
    abortFreeRatio: toFraction(value.abortFreeRatio, d.abortFreeRatio),
    sustainedMs: toPositiveMs(value.sustainedMs, d.sustainedMs),
    pollMs: toPositiveMs(value.pollMs, d.pollMs) || d.pollMs,
    maxHoldMs: toPositiveMs(value.maxHoldMs, d.maxHoldMs),
  };
}

export class MemoryGovernor {
  /**
   * @param {object|boolean} options - a `memory_guard` config value (see resolveMemoryGuard).
   * @param {object} [deps] - injectable dependencies for testing.
   * @param {object}   [deps.logger]      - logger (defaults to the shared library logger).
   * @param {Function} [deps.freeRatioFn] - () => current free-RAM fraction (0..1).
   * @param {Function} [deps.now]         - () => current epoch ms.
   * @param {Function} [deps.setTimeoutFn]   - (fn, ms) => timer handle.
   * @param {Function} [deps.clearTimeoutFn] - (handle) => void.
   */
  constructor(options = {}, deps = {}) {
    this.opts = resolveMemoryGuard(options);
    this.logger = deps.logger ?? defaultLogger;
    this._freeRatioFn =
      deps.freeRatioFn ?? (() => os.freemem() / os.totalmem());
    this._now = deps.now ?? (() => Date.now());
    this._setTimeout = deps.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms));
    this._clearTimeout = deps.clearTimeoutFn ?? ((t) => clearTimeout(t));

    this._watchTimer = null;
    this._belowSince = null; // epoch ms when free RAM first dropped under the critical floor
    this._aborted = false;
  }

  get enabled() {
    return this.opts.enabled;
  }

  /** Current free-RAM fraction, clamped to [0, 1]. */
  freeRatio() {
    const r = this._freeRatioFn();
    if (!Number.isFinite(r)) return 1;
    return Math.min(1, Math.max(0, r));
  }

  /** Current free RAM as an integer percentage, for log lines. */
  freePercent() {
    return Math.round(this.freeRatio() * 100);
  }

  _sleep(ms) {
    return new Promise((resolve) => this._setTimeout(resolve, ms));
  }

  /**
   * Admission gate. Resolves once it is safe to dispatch the next command.
   *
   * Fast path (the overwhelmingly common case on a healthy box): free RAM is above the admission
   * floor, so this returns without sleeping. It only blocks when (a) the guard is enabled, (b) at
   * least one command is already in flight, and (c) free RAM is under the floor — and even then only
   * until memory recovers or `maxHoldMs` elapses.
   *
   * @param {number} inFlight - how many commands are already running in this phase.
   */
  async waitForHeadroom(inFlight) {
    if (!this.opts.enabled) return;
    // Never hold the first/only command: you can't free memory by waiting on yourself, and the run
    // must always make progress.
    if (inFlight <= 0) return;
    if (this.freeRatio() >= this.opts.minFreeRatio) return;

    const floorPct = Math.round(this.opts.minFreeRatio * 100);
    const start = this._now();
    this.logger.info(
      `🧠 [memory-guard] holding next command — free RAM ${this.freePercent()}% < admission floor ${floorPct}% (${inFlight} running)`,
    );

    while (this.freeRatio() < this.opts.minFreeRatio) {
      const waited = this._now() - start;
      if (waited >= this.opts.maxHoldMs) {
        this.logger.warn(
          `🧠 [memory-guard] free RAM still ${this.freePercent()}% after holding ${Math.round(waited / 1000)}s; ` +
            'admitting anyway (pressure looks external and may not clear).',
        );
        return;
      }
      await this._sleep(this.opts.pollMs);
    }
    this.logger.info(
      `🧠 [memory-guard] free RAM recovered to ${this.freePercent()}% — releasing held command.`,
    );
  }

  /**
   * Evaluate the abort condition for a single watchdog sample. Updates the "below since" timestamp
   * and returns true when free RAM has stayed under the critical floor for at least `sustainedMs`.
   * Pure enough to drive directly from tests.
   */
  _evaluateAbort(nowTs = this._now()) {
    if (this.freeRatio() < this.opts.abortFreeRatio) {
      if (this._belowSince == null) this._belowSince = nowTs;
      return nowTs - this._belowSince >= this.opts.sustainedMs;
    }
    this._belowSince = null;
    return false;
  }

  /**
   * Start the abort watchdog. `onCritical({ freePercent, sustainedMs })` is invoked at most once,
   * when free RAM has stayed under the critical floor for the sustained window. The caller is
   * responsible for killing the child tree and exiting; the watchdog stops itself before firing.
   * No-op when the guard is disabled.
   */
  startWatchdog(onCritical) {
    if (!this.opts.enabled || this._watchTimer) return;
    const tick = () => {
      this._watchTimer = null;
      if (this._aborted) return;
      if (this._evaluateAbort()) {
        this._aborted = true;
        const info = {
          freePercent: this.freePercent(),
          sustainedMs: this.opts.sustainedMs,
        };
        try {
          onCritical(info);
        } catch {
          // The abort handler exits the process; never let an error here keep the box wedged.
        }
        return;
      }
      this._arm(tick);
    };
    this._arm(tick);
  }

  _arm(tick) {
    this._watchTimer = this._setTimeout(tick, this.opts.pollMs);
    // Don't let the watchdog timer keep the event loop alive on its own.
    if (this._watchTimer && typeof this._watchTimer.unref === 'function') {
      this._watchTimer.unref();
    }
  }

  /** Stop scheduling further watchdog samples. */
  stopWatchdog() {
    if (this._watchTimer) {
      this._clearTimeout(this._watchTimer);
      this._watchTimer = null;
    }
  }

  /** One-line summary of the active thresholds, for the run header. */
  describe() {
    if (!this.opts.enabled) return 'memory-guard: disabled';
    return (
      `memory-guard: hold next command below ${Math.round(this.opts.minFreeRatio * 100)}% free RAM, ` +
      `abort below ${Math.round(this.opts.abortFreeRatio * 100)}% for ${Math.round(this.opts.sustainedMs / 1000)}s`
    );
  }
}
