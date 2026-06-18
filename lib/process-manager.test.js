import path from 'path';
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
