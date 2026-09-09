import fs from 'fs';
import os from 'os';
import path from 'path';
import { emitOtelTrace } from './emit-trace.js';

function readSpans(tracesPath) {
  return fs
    .readFileSync(tracesPath, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
}

describe('emitOtelTrace', () => {
  let tmpDir;
  let tracesPath;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'so-otel-'));
    tracesPath = path.join(tmpDir, 'traces.json');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('nothing timed: no file is created', async () => {
    await emitOtelTrace({
      commands: [{ command: 'build', success: true }], // no startedAt/durationMs
      gateLabel: 'lite',
      serviceName: 'svc',
      tracesPath,
      hasFailures: false,
    });
    expect(fs.existsSync(tracesPath)).toBe(false);
  });

  test('writes one root span plus one child span per timed command', async () => {
    const startedAt = new Date('2026-01-01T00:00:00.000Z').toISOString();
    await emitOtelTrace({
      commands: [
        { command: 'lint', phase: 'checks', success: true, startedAt, durationMs: 1000 },
        { command: 'test', phase: 'checks', success: false, startedAt, durationMs: 2000 },
      ],
      gateLabel: 'lite',
      serviceName: 'svc',
      tracesPath,
      hasFailures: true,
    });

    const spans = readSpans(tracesPath);
    expect(spans).toHaveLength(3); // root + 2 commands

    const root = spans.find((s) => s.name === 'scripts-orchestrator:lite');
    expect(root).toBeDefined();
    expect(root.status.code).toBe(2); // SpanStatusCode.ERROR — hasFailures: true
    expect(root.resource['service.name']).toBe('svc');

    const lintSpan = spans.find((s) => s.name === 'lint');
    expect(lintSpan.durationMs).toBe(1000);
    expect(lintSpan.status.code).toBe(1); // OK
    expect(lintSpan.parentSpanId).toBe(root.spanId);

    const testSpan = spans.find((s) => s.name === 'test');
    expect(testSpan.durationMs).toBe(2000);
    expect(testSpan.status.code).toBe(2); // ERROR — success: false
  });

  test('appends across multiple calls to the same file (root + fanned-out workspaces)', async () => {
    const startedAt = new Date().toISOString();
    const commands = [{ command: 'build', success: true, startedAt, durationMs: 10 }];
    await emitOtelTrace({ commands, gateLabel: 'a', serviceName: 'svc', tracesPath, hasFailures: false });
    await emitOtelTrace({ commands, gateLabel: 'b', serviceName: 'svc', tracesPath, hasFailures: false });
    const spans = readSpans(tracesPath);
    expect(spans.map((s) => s.name)).toEqual(
      expect.arrayContaining(['scripts-orchestrator:a', 'scripts-orchestrator:b']),
    );
  });
});
