import path from 'path';
import fs from 'fs';
import os from 'os';
import { ProcessManager } from './process-manager.js';

describe('ProcessManager.getLogPath', () => {
  test('resolves the default per-command log path under the log folder', () => {
    const pm = new ProcessManager();
    pm.setLogFolder('/tmp/example-logs');
    const result = pm.getLogPath('build -- --outDir dist');
    // Uses only the first word of the command for the filename.
    expect(result).toBe(
      path.join('/tmp/example-logs', 'scripts-orchestrator-logs', 'build.log'),
    );
  });

  test('honors a per-command log file override, resolved against cwd', () => {
    const pm = new ProcessManager();
    pm.setLogFolder('/tmp/example-logs');
    const override = './logs/scripts-orchestrator-logs/custom.log';
    const result = pm.getLogPath('lint', override);
    expect(result).toBe(path.resolve(override));
  });
});

describe('ProcessManager.runCommand prefix handling', () => {
  let tmpDir;
  let prevCwd;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'so-prefix-'));
    prevCwd = process.cwd();
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(prevCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('runs a regular bash command verbatim when prefix is disabled', async () => {
    const pm = new ProcessManager();
    pm.setLogFolder(tmpDir);
    const marker = 'orchestrator-raw-bash-ok';
    const result = await pm.runCommand({
      cmd: `echo ${marker}`,
      background: false,
      prefix: '',
    });
    expect(result.success).toBe(true);
    const logPath = pm.getLogPath(`echo ${marker}`);
    expect(fs.readFileSync(logPath, 'utf8')).toContain(marker);
  });

  test('honors a custom prefix by invoking it (failure surfaces a non-zero exit)', async () => {
    const pm = new ProcessManager();
    pm.setLogFolder(tmpDir);
    // With prefix 'npm run' and no package.json script, the command must fail —
    // proving the prefix is actually prepended rather than the command run raw.
    const result = await pm.runCommand({
      cmd: 'definitely-not-a-script',
      background: false,
      prefix: 'npm run',
    });
    expect(result.success).toBe(false);
  });

  test('supports multi-token shell commands (pipes, &&) when run raw', async () => {
    const pm = new ProcessManager();
    pm.setLogFolder(tmpDir);
    const result = await pm.runCommand({
      cmd: 'printf "a\\nb\\nc\\n" | grep b',
      background: false,
      prefix: '',
    });
    expect(result.success).toBe(true);
    const logPath = pm.getLogPath('printf');
    expect(fs.readFileSync(logPath, 'utf8').trim()).toBe('b');
  });
});

describe('ProcessManager CPU metric parsing', () => {
  const pm = new ProcessManager();

  test('parseGnuTimeCpu extracts user + system seconds from GNU time -v text', () => {
    const text = [
      '\tUser time (seconds): 2.34',
      '\tSystem time (seconds): 0.50',
      '\tPercent of CPU this job got: 142%',
      '\tMaximum resident set size (kbytes): 49086',
    ].join('\n');
    expect(pm.parseGnuTimeCpu(text)).toEqual({ userSec: 2.34, sysSec: 0.5 });
  });

  test('parseBsdTimeCpu extracts user + system seconds from macOS time -l text', () => {
    const text = '        0.07 real         0.06 user         0.02 sys\n            49086464  maximum resident set size';
    expect(pm.parseBsdTimeCpu(text)).toEqual({ userSec: 0.06, sysSec: 0.02 });
  });

  test('CPU parsers return null when no CPU fields are present', () => {
    expect(pm.parseGnuTimeCpu('nothing here')).toBeNull();
    expect(pm.parseBsdTimeCpu('nothing here')).toBeNull();
    expect(pm.parseBsdTimeCpu(null)).toBeNull();
  });

  test('computeCpuPercent derives average cores-as-percent over wall-clock', () => {
    // (2.34 + 0.50) / 2.0s wall = 1.42 cores => 142%
    expect(pm.computeCpuPercent({ userSec: 2.34, sysSec: 0.5 }, 2000)).toBe(142);
    // single core fully used for the whole duration
    expect(pm.computeCpuPercent({ userSec: 1, sysSec: 0 }, 1000)).toBe(100);
  });

  test('computeCpuPercent guards against missing input / zero duration', () => {
    expect(pm.computeCpuPercent(null, 1000)).toBeNull();
    expect(pm.computeCpuPercent({ userSec: 1, sysSec: 0 }, 0)).toBeNull();
  });

  test('parseGnuTimeMemory still reads peak RSS from the same GNU text', () => {
    const text = '\tUser time (seconds): 2.34\n\tMaximum resident set size (kbytes): 49086';
    expect(pm.parseGnuTimeMemory(text)).toBe(49086);
  });
});
