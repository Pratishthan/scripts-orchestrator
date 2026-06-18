import {
  computeBudget,
  usableSteps,
  observedTimeline,
  packPhases,
  recommendPhases,
  decideVerdict,
  formatRecommendationReport,
} from './recommend-phases.js';

const GB_KB = 1024 * 1024; // 1 GB expressed in KB

// A small synthetic run loosely modelled on the finalyzerui worktree profile.
const payload = {
  success: true,
  commands: [
    { command: 'build', phase: 'build', success: true, durationMs: 123000, memoryKb: 3.5 * GB_KB },
    { command: 'type-check', phase: 'build', success: true, durationMs: 28000, memoryKb: 1.9 * GB_KB },
    { command: 'test-ci', phase: 'tests', success: true, durationMs: 92000, memoryKb: 1.3 * GB_KB },
    { command: 'build-storybook', phase: 'storybook', success: true, durationMs: 97000, memoryKb: 6.8 * GB_KB },
    { command: 'lint-ci', phase: 'lint', success: true, durationMs: 6500, memoryKb: 0.3 * GB_KB },
    { command: 'disabled-thing', phase: 'lint', success: true, durationMs: 0, skipReason: 'disabled' },
  ],
};

describe('computeBudget', () => {
  test('derives budget and core share from host inputs and fan-out', () => {
    const b = computeBudget({ totalMemBytes: 16 * 1024 ** 3, cores: 10, fanout: 1, memSafety: 0.8 });
    expect(b.budgetBytes).toBeCloseTo(16 * 1024 ** 3 * 0.8);
    expect(b.coreShare).toBe(8); // (10 - 2) / 1
  });

  test('fan-out divides both memory and core budgets', () => {
    const b = computeBudget({ totalMemBytes: 32 * 1024 ** 3, cores: 12, fanout: 2, memSafety: 0.8 });
    expect(b.budgetBytes).toBeCloseTo((32 * 1024 ** 3 * 0.8) / 2);
    expect(b.coreShare).toBe(5); // floor((12 - 2) / 2)
  });

  test('budgetMb overrides the computed budget; core share never drops below 1', () => {
    const b = computeBudget({ totalMemBytes: 8 * 1024 ** 3, cores: 2, budgetMb: 4096 });
    expect(b.budgetBytes).toBe(4096 * 1024 * 1024);
    expect(b.coreShare).toBe(1);
  });
});

describe('usableSteps', () => {
  test('drops skipped/untimed commands and normalises fields', () => {
    const steps = usableSteps(payload);
    expect(steps.map((s) => s.command)).not.toContain('disabled-thing');
    expect(steps).toHaveLength(5);
    expect(steps.every((s) => s.durationMs > 0)).toBe(true);
  });
});

describe('observedTimeline', () => {
  test('groups by phase, sums concurrent peaks, flags over-budget phases', () => {
    const steps = usableSteps(payload);
    const budgetBytes = 4 * 1024 ** 3; // 4 GB
    const tl = observedTimeline(steps, budgetBytes);
    const build = tl.find((p) => p.name === 'build');
    // build (3.5) + type-check (1.9) = 5.4 GB > 4 GB budget
    expect(build.overBudget).toBe(true);
    expect(build.wallclockMs).toBe(123000); // max of its members
  });
});

describe('packPhases (First-Fit-Decreasing)', () => {
  test('keeps each bin under the memory budget and respects core share', () => {
    const steps = usableSteps(payload);
    const budgetBytes = 12.8 * 1024 ** 3; // 16 GB laptop @ 0.8
    const bins = packPhases(steps, budgetBytes, 8);
    for (const bin of bins) {
      expect(bin.memBytes).toBeLessThanOrEqual(budgetBytes);
      expect(bin.steps.length).toBeLessThanOrEqual(8);
    }
    // longest step seeds the first bin
    expect(bins[0].steps[0].command).toBe('build');
  });

  test('a lone oversized step gets its own bin and is flagged', () => {
    const big = [{ command: 'huge', phase: 'p', durationMs: 1000, memoryKb: 10 * GB_KB }];
    const bins = packPhases(big, 4 * 1024 ** 3, 8);
    expect(bins).toHaveLength(1);
    expect(bins[0].exceedsBudget).toBe(true);
  });
});

describe('recommendPhases', () => {
  test('packed makespan beats the sequential-phase makespan on a constrained host', () => {
    const rec = recommendPhases(payload, { totalMemBytes: 16 * 1024 ** 3, cores: 10, fanout: 1 });
    expect(rec.recommended.makespanMs).toBeLessThan(rec.observedMakespanMs);
    expect(rec.optimalMakespanMs).toBe(123000); // single longest step
  });

  test('warns when no memory metrics are present', () => {
    const rec = recommendPhases({
      commands: [{ command: 'a', phase: 'p', success: true, durationMs: 1000 }],
    });
    expect(rec.warnings.join(' ')).toMatch(/memory/i);
  });

  test('empty results produce a graceful warning, no throw', () => {
    const rec = recommendPhases({ commands: [] });
    expect(rec.steps).toHaveLength(0);
    expect(rec.warnings.join(' ')).toMatch(/nothing to recommend/i);
    expect(() => formatRecommendationReport(rec)).not.toThrow();
  });

  test('attaches a verdict object to the recommendation', () => {
    const rec = recommendPhases(payload, { totalMemBytes: 16 * 1024 ** 3, cores: 10, fanout: 1 });
    expect(rec.verdict).toBeDefined();
    expect(typeof rec.verdict.worthwhile).toBe('boolean');
    expect(typeof rec.verdict.reason).toBe('string');
  });
});

describe('decideVerdict', () => {
  const longest = { command: 'build', durationMs: 600000 };

  test('says yes when packing trims a meaningful chunk off the makespan', () => {
    const v = decideVerdict({
      steps: [{}, {}, {}],
      observedMakespanMs: 100000,
      recommendedMakespanMs: 70000, // 30s / 30% saved
      optimalMakespanMs: 60000,
      longestStep: longest,
      binCount: 2,
    });
    expect(v.worthwhile).toBe(true);
    expect(v.savedMs).toBe(30000);
  });

  test('says no — and points at the monolith — when one step dominates', () => {
    const v = decideVerdict({
      steps: [{}, {}],
      observedMakespanMs: 610000,
      recommendedMakespanMs: 610000,
      optimalMakespanMs: 600000, // ~98% of makespan
      longestStep: longest,
      binCount: 1,
    });
    expect(v.worthwhile).toBe(false);
    expect(v.reason).toMatch(/split that step/i);
    expect(v.reason).toContain('build');
  });

  test('says no when the saving is below the threshold', () => {
    const v = decideVerdict({
      steps: [{}, {}, {}, {}],
      observedMakespanMs: 100000,
      recommendedMakespanMs: 98000, // only 2% / 2s
      optimalMakespanMs: 40000,
      longestStep: longest,
      binCount: 2,
    });
    expect(v.worthwhile).toBe(false);
    expect(v.reason).toMatch(/isn't worth it|within/i);
  });

  test('handles the no-steps case', () => {
    const v = decideVerdict({ steps: [], observedMakespanMs: 0, recommendedMakespanMs: 0, optimalMakespanMs: 0, longestStep: null, binCount: 0 });
    expect(v.worthwhile).toBe(false);
  });
});
