import fs from 'fs';
import os from 'os';
import path from 'path';
import { Orchestrator } from './orchestrator.js';

const baseConfig = () => ({
  phases: [{ name: 'p', parallel: [{ command: 'build' }] }],
});

describe('Orchestrator OTEL trace emission', () => {
  let tmpDir;
  let tracesPath;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'so-otel-orch-'));
    tracesPath = path.join(tmpDir, 'traces.json');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('otel not configured: no trace file, no error', async () => {
    const orch = new Orchestrator(baseConfig());
    orch._lastResultCommands = [
      { command: 'build', success: true, startedAt: new Date().toISOString(), durationMs: 5 },
    ];
    await orch._emitOtelTrace(false);
    expect(fs.existsSync(tracesPath)).toBe(false);
  });

  test('otel configured: writes a trace file derived from jsonResultsPath', async () => {
    const orch = new Orchestrator(baseConfig(), null, null, null, false, false, [], 'scripts-orchestrator-lite-results.json');
    orch.otelOptions = { serviceName: 'svc', filePath: tracesPath };
    orch._lastResultCommands = [
      { command: 'build', success: true, startedAt: new Date().toISOString(), durationMs: 5 },
    ];
    await orch._emitOtelTrace(false);
    expect(fs.existsSync(tracesPath)).toBe(true);
    const spans = fs
      .readFileSync(tracesPath, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    const root = spans.find((s) => s.name === 'scripts-orchestrator:lite');
    expect(root).toBeDefined();
    expect(root.resource['service.name']).toBe('svc');
  });

  test('default tracesPath (no filePath, no env var) is derived from this.logFolder', async () => {
    const orch = new Orchestrator(baseConfig(), null, tmpDir);
    orch.otelOptions = { serviceName: 'svc' };
    orch._lastResultCommands = [
      { command: 'build', success: true, startedAt: new Date().toISOString(), durationMs: 5 },
    ];
    await orch._emitOtelTrace(false);
    expect(fs.existsSync(path.join(tmpDir, '.otel-logs', 'traces.json'))).toBe(true);
  });

  test('a failure inside trace emission is swallowed (non-fatal), like post_run', async () => {
    const orch = new Orchestrator(baseConfig());
    // Force a real failure: make a path component of the traces file a plain file, so
    // FileSpanExporter's constructor (`mkdirSync` on the parent dir) throws ENOTDIR.
    const blockingFile = path.join(tmpDir, 'blocking-file');
    fs.writeFileSync(blockingFile, '');
    const badTracesPath = path.join(blockingFile, 'traces.json');
    orch.otelOptions = { serviceName: 'svc', filePath: badTracesPath };
    orch._lastResultCommands = [
      { command: 'build', success: true, startedAt: new Date().toISOString(), durationMs: 5 },
    ];
    const warnings = [];
    orch.logger.warn = (msg) => warnings.push(msg);
    await expect(orch._emitOtelTrace(false)).resolves.toBeUndefined();
    expect(warnings.some((w) => w.includes('[otel]'))).toBe(true);
  });
});
