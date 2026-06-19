import { renderReportHtml } from './report-html.js';

describe('renderReportHtml', () => {
  test('renders a flat payload with a commands table and status badges', () => {
    const html = renderReportHtml({
      success: true,
      timestamp: '2026-06-17T00:00:00.000Z',
      overallDurationMs: 5000,
      commands: [
        { command: 'build', success: true, durationMs: 2000, logFile: 'logs/build.log' },
        { command: 'lint', success: false, durationMs: 1000 },
      ],
    });
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('Total time');
    expect(html).toContain('<code>build</code>');
    expect(html).toContain('badge ok');
    expect(html).toContain('badge fail');
    expect(html).toContain('logs/build.log'); // log link rendered
  });

  test('running (success: null) renders a Running state, not a failure', () => {
    const html = renderReportHtml({
      success: null,
      timestamp: '2026-06-17T00:00:00.000Z',
      overallDurationMs: 1000,
      commands: [{ command: 'build', success: null, startedAt: '2026-06-17T00:00:00.000Z' }],
    });
    expect(html).toContain('Running…');
    expect(html).toContain('Elapsed'); // elapsed label while running
    expect(html).toContain('badge running');
    expect(html).not.toContain('badge fail');
  });

  test('renders nested sections as collapsible blocks with their titles', () => {
    const html = renderReportHtml({
      success: false,
      timestamp: '2026-06-17T00:00:00.000Z',
      title: 'Monorepo Quality Report',
      sections: [
        { title: 'Global checks', success: true, commands: [{ command: 'lint', success: true, durationMs: 100 }] },
        {
          title: 'apps/web',
          success: false,
          statusKind: 'fail',
          meta: { path: 'apps/web', state: 'RUNNING' },
          commands: [{ command: 'test', success: false, durationMs: 200 }],
        },
      ],
    });
    expect(html).toContain('Monorepo Quality Report');
    expect(html).toContain('<details');
    expect(html).toContain('Global checks');
    expect(html).toContain('apps/web');
    // meta values rendered opaquely
    expect(html).toContain('RUNNING');
  });

  test('columns are the union of keys; unknown keys become plain text columns', () => {
    const html = renderReportHtml({
      success: true,
      timestamp: 't',
      commands: [
        { command: 'a', success: true, durationMs: 10, scope: 'global' },
        { command: 'b', success: true, memoryKb: 2048 }, // no durationMs, has memory
      ],
    });
    // unknown key 'scope' becomes a humanized column header + value
    expect(html).toContain('<th>Scope</th>');
    expect(html).toContain('global');
    // memory column present because at least one row has it
    expect(html).toContain('<th>Memory</th>');
    expect(html).toContain('MB');
    // raw 'success'/'startedAt' are never raw columns
    expect(html).not.toContain('<th>Success</th>');
    expect(html).not.toContain('<th>Started At</th>');
  });

  test('statusKind drives the badge color for custom states', () => {
    const html = renderReportHtml({
      success: true,
      timestamp: 't',
      sections: [{ title: 'cached', statusKind: 'warn', statusLabel: 'NX CACHE', commands: [] }],
    });
    expect(html).toContain('badge warn');
    expect(html).toContain('NX CACHE');
  });

  test('Memory table cell uses the same green→red heat scale as the Gantt', () => {
    const html = renderReportHtml({
      success: true,
      timestamp: 't',
      overallDurationMs: 10000,
      commands: [
        { command: 'light', success: true, durationMs: 2000, memoryKb: 100 * 1024 },
        { command: 'heavy', success: true, durationMs: 3000, memoryKb: 2048 * 1024 },
      ],
    });
    // heaviest cell heat-coloured red; lightest green — both bar and value text
    expect(html).toContain('bar mem mem-high');
    expect(html).toContain('bar mem mem-low');
    expect(html).toContain('memval mem-high');
    expect(html).toContain('memval mem-low');
  });

  test('memoryHeat thresholds are configurable via payload.memoryHeat', () => {
    // With a low high-threshold (0.4), a command at 50% of peak should read as high.
    const payload = {
      success: true,
      timestamp: 't',
      overallDurationMs: 10000,
      memoryHeat: { mid: 0.2, high: 0.4 },
      commands: [
        { command: 'mid', success: true, startedAt: '2026-06-17T00:00:00.000Z', durationMs: 1000, memoryKb: 500 * 1024 }, // 50% of peak
        { command: 'peak', success: true, startedAt: '2026-06-17T00:00:01.000Z', durationMs: 1000, memoryKb: 1000 * 1024 },
      ],
    };
    const html = renderReportHtml(payload);
    // 50% ≥ configured high (40%) → high; default thresholds (66%) would have made it 'mid'.
    expect(html).toContain('bar mem mem-high');
    expect(html).not.toContain('bar mem mem-mid');
    // legend reflects the configured thresholds
    expect(html).toContain('amber ≥ 20%, red ≥ 40%');
  });

  test('invalid memoryHeat thresholds fall back to defaults', () => {
    const html = renderReportHtml({
      success: true,
      timestamp: 't',
      overallDurationMs: 10000,
      memoryHeat: { mid: 0.9, high: 0.1 }, // mid >= high → invalid, use defaults
      commands: [
        { command: 'a', success: true, startedAt: '2026-06-17T00:00:00.000Z', durationMs: 1000, memoryKb: 500 * 1024 },
        { command: 'b', success: true, startedAt: '2026-06-17T00:00:01.000Z', durationMs: 1000, memoryKb: 1000 * 1024 },
      ],
    });
    // default thresholds restored: 50% of peak → mid (≥33%, <66%)
    expect(html).toContain('amber ≥ 33%, red ≥ 66%');
    expect(html).toContain('bar mem mem-mid');
  });

  test('Gantt flags memory-heavy commands with a heat ring and memory chip', () => {
    const html = renderReportHtml({
      success: true,
      timestamp: 't',
      overallDurationMs: 10000,
      commands: [
        { command: 'light', success: true, startedAt: '2026-06-17T00:00:00.000Z', durationMs: 2000, memoryKb: 100 * 1024 },
        { command: 'heavy', success: true, startedAt: '2026-06-17T00:00:01.000Z', durationMs: 3000, memoryKb: 2048 * 1024 },
      ],
    });
    // heaviest command gets the high-heat ring + bold chip; lightest gets low
    expect(html).toContain('mem-high');
    expect(html).toContain('mem-low');
    // memory value surfaced on the Gantt row itself (no table lookup needed)
    expect(html).toContain('class="gantt-mem');
    expect(html).toContain('2.0 GB');
  });

  test('Gantt omits the memory chip entirely when no command reports memory', () => {
    const html = renderReportHtml({
      success: true,
      timestamp: 't',
      overallDurationMs: 10000,
      commands: [
        { command: 'a', success: true, startedAt: '2026-06-17T00:00:00.000Z', durationMs: 2000 },
      ],
    });
    // no rendered chip element and no heat ring on the bar
    expect(html).not.toContain('class="gantt-mem');
    expect(html).not.toContain('gantt-bar  mem-');
    expect(html).not.toContain('gantt-bar crit mem-');
  });
});
