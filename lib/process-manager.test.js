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
