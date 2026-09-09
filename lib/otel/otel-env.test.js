import path from 'path';
import { setupOtelEnvDefaults } from './otel-env.js';

const OTEL_VARS = ['OTEL_TRACES_EXPORTER', 'OTEL_EXPORTER_FILE_PATH', 'OTEL_SERVICE_NAME'];

describe('setupOtelEnvDefaults', () => {
  let saved;

  beforeEach(() => {
    saved = Object.fromEntries(OTEL_VARS.map((v) => [v, process.env[v]]));
    OTEL_VARS.forEach((v) => delete process.env[v]);
  });

  afterEach(() => {
    OTEL_VARS.forEach((v) => {
      if (saved[v] === undefined) delete process.env[v];
      else process.env[v] = saved[v];
    });
  });

  test('fills all three vars when unset', () => {
    setupOtelEnvDefaults({ repoRoot: '/repo', serviceName: 'scripts-orchestrator:root' });
    expect(process.env.OTEL_TRACES_EXPORTER).toBe('file');
    expect(process.env.OTEL_EXPORTER_FILE_PATH).toBe('/repo/.otel-logs/traces.json');
    expect(process.env.OTEL_SERVICE_NAME).toBe('scripts-orchestrator:root');
  });

  test('leaves already-set vars alone (a real OTLP collector config is not clobbered)', () => {
    process.env.OTEL_TRACES_EXPORTER = 'otlp';
    process.env.OTEL_EXPORTER_FILE_PATH = '/somewhere/else.json';
    process.env.OTEL_SERVICE_NAME = 'my-service';
    setupOtelEnvDefaults({ repoRoot: '/repo', serviceName: 'scripts-orchestrator:root' });
    expect(process.env.OTEL_TRACES_EXPORTER).toBe('otlp');
    expect(process.env.OTEL_EXPORTER_FILE_PATH).toBe('/somewhere/else.json');
    expect(process.env.OTEL_SERVICE_NAME).toBe('my-service');
  });

  test('without a serviceName, OTEL_SERVICE_NAME is left unset', () => {
    setupOtelEnvDefaults({ repoRoot: '/repo' });
    expect(process.env.OTEL_SERVICE_NAME).toBeUndefined();
  });

  test('logFolder takes precedence over repoRoot — .otel-logs lives alongside the gate\'s other artifacts', () => {
    setupOtelEnvDefaults({ logFolder: '/repo/apps/finalyzerui/logs', repoRoot: '/repo' });
    expect(process.env.OTEL_EXPORTER_FILE_PATH).toBe(
      '/repo/apps/finalyzerui/logs/.otel-logs/traces.json',
    );
  });

  test('a relative logFolder is resolved against process.cwd()', () => {
    setupOtelEnvDefaults({ logFolder: './logs' });
    expect(process.env.OTEL_EXPORTER_FILE_PATH).toBe(
      path.join(process.cwd(), 'logs', '.otel-logs', 'traces.json'),
    );
  });
});
