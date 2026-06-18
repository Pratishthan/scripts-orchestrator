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
});
