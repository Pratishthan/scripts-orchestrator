import {
  computeBudget,
  usableSteps,
  stepCores,
  observedTimeline,
  packPhases,
  recommendPhases,
  decideVerdict,
  formatRecommendationReport,
} from './recommend-phases.js';

const GB_KB = 1024 * 1024; // 1 GB expressed in KB

// A small synthetic run loosely modelled on the finalyzerui worktree profile.
// cpuPercent: 100 = one core busy for the whole step; >100 = a parallel/CPU-bound step.
const payload = {
  success: true,
  commands: [
    { command: 'build', phase: 'build', success: true, durationMs: 123000, memoryKb: 3.5 * GB_KB, cpuPercent: 280 },
    { command: 'type-check', phase: 'build', success: true, durationMs: 28000, memoryKb: 1.9 * GB_KB, cpuPercent: 110 },
    { command: 'test-ci', phase: 'tests', success: true, durationMs: 92000, memoryKb: 1.3 * GB_KB, cpuPercent: 420 },
    { command: 'build-storybook', phase: 'storybook', success: true, durationMs: 97000, memoryKb: 6.8 * GB_KB, cpuPercent: 150 },
    { command: 'lint-ci', phase: 'lint', success: true, durationMs: 6500, memoryKb: 0.3 * GB_KB, cpuPercent: 60 },
    { command: 'disabled-thing', phase: 'lint', success: true, durationMs: 0, skipReason: 'disabled' },
  ],
};

// A whole-monorepo roll-up report: commands live under sections[] (one per scope) rather than a
// flat top-level `commands` array. Includes a global-checks section, two workspace sections that
// each have a `build` phase (to exercise per-scope phase namespacing), an empty section (skipped),
// and a partial/in-progress section.
const aggregatePayload = {
  title: 'Monorepo Quality Report',
  success: true,
  inProgress: false,
  sections: [
    {
      title: 'Global quality checks',
      commands: [
        { command: 'lint', phase: 'global', success: true, durationMs: 2100, memoryKb: 0.3 * GB_KB, cpuPercent: 60 },
      ],
    },
    {
      title: '@app/web',
      meta: { path: 'apps/web' },
      commands: [
        { command: 'build', phase: 'build', success: true, durationMs: 50000, memoryKb: 2 * GB_KB, cpuPercent: 200 },
        { command: 'test-ci', phase: 'tests', success: true, durationMs: 30000, memoryKb: 1.2 * GB_KB, cpuPercent: 300 },
        { command: 'disabled-thing', phase: 'lint', success: true, durationMs: 0, skipReason: 'disabled' },
      ],
    },
    {
      title: '@app/api',
      meta: { path: 'apps/api' },
      commands: [
        { command: 'build', phase: 'build', success: true, durationMs: 40000, memoryKb: 1.5 * GB_KB, cpuPercent: 180 },
      ],
    },
    {
      title: '@app/empty',
      meta: { path: 'apps/empty' },
      commands: [], // pending/stale/no-op — contributes no steps
    },
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

describe('usableSteps (CPU)', () => {
  test('carries cpuPercent through; absent CPU normalises to 0', () => {
    const steps = usableSteps(payload);
    expect(steps.find((s) => s.command === 'test-ci').cpuPercent).toBe(420);
    const noCpu = usableSteps({ commands: [{ command: 'a', phase: 'p', durationMs: 10 }] });
    expect(noCpu[0].cpuPercent).toBe(0);
  });
});

describe('stepCores', () => {
  test('converts cpuPercent to core-equivalents', () => {
    expect(stepCores({ cpuPercent: 420 })).toBeCloseTo(4.2);
    expect(stepCores({ cpuPercent: 60 })).toBeCloseTo(0.6);
  });

  test('defaults to one core when the CPU metric is absent', () => {
    expect(stepCores({ cpuPercent: 0 })).toBe(1);
    expect(stepCores({})).toBe(1);
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

  test('sums concurrent CPU demand and flags phases over the core share', () => {
    const steps = usableSteps(payload);
    const tl = observedTimeline(steps, 64 * 1024 ** 3, 3); // generous RAM, tight 3-core share
    const build = tl.find((p) => p.name === 'build');
    // build (2.8) + type-check (1.1) = 3.9 cores > 3-core share
    expect(build.concurrentCpuCores).toBeCloseTo(3.9);
    expect(build.overCores).toBe(true);
    // lint-ci alone is 0.6 cores — comfortably under the share
    expect(tl.find((p) => p.name === 'lint').overCores).toBe(false);
  });

  test('does not flag over-cores when no core share is supplied', () => {
    const tl = observedTimeline(usableSteps(payload), 4 * 1024 ** 3);
    expect(tl.every((p) => p.overCores === false)).toBe(true);
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

  test('keeps each bin under the core share using real CPU demand', () => {
    const steps = usableSteps(payload);
    const bins = packPhases(steps, 64 * 1024 ** 3, 5); // RAM not the constraint; 5-core share
    for (const bin of bins) {
      expect(bin.cpuCores).toBeLessThanOrEqual(5 + 1e-9);
    }
    // total demand is 10.2 cores → at a 5-core share it cannot all fit in one phase
    expect(bins.length).toBeGreaterThan(1);
  });

  test('packs I/O-bound (sub-core) steps denser than the old one-per-core model', () => {
    // Six steps each ~0.3 cores (I/O-bound: 30% CPU). The crude "≤ core-share steps" rule would
    // need 3 bins at a 2-core share; CPU-aware packing fits all six (Σ 1.8 cores) in one bin.
    const ioBound = Array.from({ length: 6 }, (_, i) => ({
      command: `io-${i}`,
      phase: 'p',
      durationMs: 1000,
      memoryKb: 0.1 * GB_KB,
      cpuPercent: 30,
    }));
    const bins = packPhases(ioBound, 64 * 1024 ** 3, 2);
    expect(bins).toHaveLength(1);
    expect(bins[0].cpuCores).toBeCloseTo(1.8);
  });

  test('a lone CPU-heavy step gets its own bin and is flagged', () => {
    const heavy = [{ command: 'mega', phase: 'p', durationMs: 1000, memoryKb: 0.1 * GB_KB, cpuPercent: 800 }];
    const bins = packPhases(heavy, 64 * 1024 ** 3, 5); // 8 cores demanded, 5-core share
    expect(bins).toHaveLength(1);
    expect(bins[0].exceedsCores).toBe(true);
  });

  test('with no CPU metric, the core share still bounds steps-per-phase', () => {
    const noCpu = Array.from({ length: 5 }, (_, i) => ({
      command: `c-${i}`,
      phase: 'p',
      durationMs: 1000,
      memoryKb: 0.1 * GB_KB,
      cpuPercent: 0, // each counts as one core
    }));
    const bins = packPhases(noCpu, 64 * 1024 ** 3, 2);
    for (const bin of bins) expect(bin.steps.length).toBeLessThanOrEqual(2);
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

  test('warns when no CPU metrics are present', () => {
    const rec = recommendPhases({
      commands: [{ command: 'a', phase: 'p', success: true, durationMs: 1000, memoryKb: GB_KB }],
    });
    expect(rec.warnings.join(' ')).toMatch(/CPU/i);
  });

  test('does not warn about CPU when the metric is present', () => {
    const rec = recommendPhases(payload, { totalMemBytes: 16 * 1024 ** 3, cores: 10, fanout: 1 });
    expect(rec.warnings.join(' ')).not.toMatch(/No CPU metrics/i);
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

describe('usableSteps (roll-up / cross-scope)', () => {
  test('flattens every non-empty section, dropping skipped/untimed commands', () => {
    const steps = usableSteps(aggregatePayload);
    // global lint + web build + web test-ci + api build = 4 (web's disabled-thing and the empty
    // section contribute nothing).
    expect(steps).toHaveLength(4);
    expect(steps.some((s) => s.command.includes('disabled-thing'))).toBe(false);
  });

  test('namespaces phase and labels command with the originating scope', () => {
    const steps = usableSteps(aggregatePayload);
    const webBuild = steps.find((s) => s.command === '@app/web: build');
    expect(webBuild).toBeDefined();
    expect(webBuild.phase).toBe('@app/web › build');
    expect(webBuild.scope).toBe('@app/web');
  });

  test('tags the global-checks section as the "global" scope', () => {
    const steps = usableSteps(aggregatePayload);
    const lint = steps.find((s) => s.command === 'global: lint');
    expect(lint).toBeDefined();
    expect(lint.phase).toBe('global › global');
    expect(lint.scope).toBe('global');
  });

  test('two scopes sharing a phase name stay distinct in the observed timeline', () => {
    const tl = observedTimeline(usableSteps(aggregatePayload), 64 * 1024 ** 3, 8);
    const names = tl.map((p) => p.name);
    expect(names).toContain('@app/web › build');
    expect(names).toContain('@app/api › build');
    // Not merged into a single synthetic "build" phase.
    expect(names).not.toContain('build');
  });

  test('the single-scope (flat) path is unchanged — no scope tag, bare command names', () => {
    const steps = usableSteps(payload);
    expect(steps).toHaveLength(5);
    expect(steps.map((s) => s.command)).toContain('build');
    expect(steps.every((s) => s.scope === undefined)).toBe(true);
  });
});

describe('recommendPhases (roll-up / cross-scope)', () => {
  test('reports the roll-up scope count and aggregate flag', () => {
    const rec = recommendPhases(aggregatePayload, { totalMemBytes: 16 * 1024 ** 3, cores: 10, fanout: 1 });
    expect(rec.aggregate).toBe(true);
    expect(rec.scopeCount).toBe(3); // global + web + api (empty section excluded)
    expect(rec.partial).toBe(false);
  });

  test('the flat path reports aggregate=false and zero scopes', () => {
    const rec = recommendPhases(payload, { totalMemBytes: 16 * 1024 ** 3, cores: 10, fanout: 1 });
    expect(rec.aggregate).toBe(false);
    expect(rec.scopeCount).toBe(0);
    expect(rec.partial).toBe(false);
  });

  test('warns and flags partial when the roll-up is mid-run', () => {
    const rec = recommendPhases(
      { ...aggregatePayload, inProgress: true },
      { totalMemBytes: 16 * 1024 ** 3, cores: 10, fanout: 1 },
    );
    expect(rec.partial).toBe(true);
    expect(rec.warnings.join(' ')).toMatch(/partial|in-progress/i);
  });

  test('a section flagged as a partial command list marks the roll-up partial', () => {
    const withNote = {
      sections: [
        {
          title: '@app/web',
          meta: { path: 'apps/web', note: 'In progress — partial command list' },
          commands: [{ command: 'build', phase: 'build', durationMs: 1000, memoryKb: GB_KB, cpuPercent: 100 }],
        },
      ],
    };
    const rec = recommendPhases(withNote, { totalMemBytes: 16 * 1024 ** 3, cores: 10, fanout: 1 });
    expect(rec.partial).toBe(true);
  });

  test('the report carries the roll-up header; the flat report does not', () => {
    const aggRec = recommendPhases(aggregatePayload, { totalMemBytes: 16 * 1024 ** 3, cores: 10, fanout: 1 });
    const flatRec = recommendPhases(payload, { totalMemBytes: 16 * 1024 ** 3, cores: 10, fanout: 1 });
    expect(formatRecommendationReport(aggRec)).toMatch(/Aggregated across 3 scope/);
    expect(formatRecommendationReport(flatRec)).not.toMatch(/Aggregated across/);
  });

  test('an unrecognised payload (no commands, no sections) warns and produces no steps', () => {
    const rec = recommendPhases({ title: 'x' });
    expect(rec.steps).toHaveLength(0);
    expect(rec.aggregate).toBe(false);
    expect(rec.warnings.join(' ')).toMatch(/not a recognised/i);
    expect(() => formatRecommendationReport(rec)).not.toThrow();
  });
});
