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

describe('ProcessManager.killProcessGroup', () => {
  test('signals the whole process group (negative pgid) first, then the bare pid', () => {
    const pm = new ProcessManager();
    const calls = [];
    const orig = process.kill;
    process.kill = (pid, sig) => {
      calls.push([pid, sig]);
      return true;
    };
    try {
      expect(pm.killProcessGroup(4242, 'SIGTERM')).toBe(true);
    } finally {
      process.kill = orig;
    }
    // The group signal (negative pgid) is attempted before the bare-pid fallback.
    expect(calls[0]).toEqual([-4242, 'SIGTERM']);
    expect(calls).toContainEqual([4242, 'SIGTERM']);
  });

  test('still delivers to the bare pid when the child is not a group leader', () => {
    const pm = new ProcessManager();
    const calls = [];
    const orig = process.kill;
    process.kill = (pid, sig) => {
      calls.push([pid, sig]);
      if (pid < 0) {
        const err = new Error('no such process group');
        err.code = 'ESRCH';
        throw err;
      }
      return true;
    };
    let delivered;
    try {
      delivered = pm.killProcessGroup(99, 'SIGKILL');
    } finally {
      process.kill = orig;
    }
    expect(delivered).toBe(true);
    expect(calls).toContainEqual([99, 'SIGKILL']);
  });
});

describe('ProcessManager.cleanupPhase', () => {
  test('tears down phase-scoped background processes and spares persist:true ones', async () => {
    const pm = new ProcessManager();
    const killed = [];
    // Stub the heavy per-process teardown so we test only the phase scoping/bookkeeping.
    pm.cleanupProcess = async ({ command }) => {
      killed.push(command);
    };
    pm.backgroundProcesses = [101, 102, 103];
    pm.backgroundProcessesDetails = [
      { command: 'dev-a', pgid: 101, phase: 'storybook tests', persist: false, startedByScript: true },
      { command: 'dev-shared', pgid: 102, phase: 'playwright tests', persist: true, startedByScript: true },
      { command: 'dev-b', pgid: 103, phase: 'storybook tests', persist: false, startedByScript: true },
    ];

    await pm.cleanupPhase('storybook tests');

    expect(killed.sort()).toEqual(['dev-a', 'dev-b']);
    // The persisted process (and any other-phase entry) stays tracked for run-end cleanup.
    expect(pm.backgroundProcessesDetails.map((p) => p.command)).toEqual(['dev-shared']);
    expect(pm.backgroundProcesses).toEqual([102]);
  });

  test('is a no-op when a phase started no non-persist background processes', async () => {
    const pm = new ProcessManager();
    let calls = 0;
    pm.cleanupProcess = async () => {
      calls += 1;
    };
    pm.backgroundProcessesDetails = [
      { command: 'dev-shared', pgid: 1, phase: 'playwright tests', persist: true, startedByScript: true },
    ];
    await pm.cleanupPhase('playwright tests');
    expect(calls).toBe(0);
    expect(pm.backgroundProcessesDetails).toHaveLength(1);
  });
});

describe('ProcessManager background dependency teardown (real process tree)', () => {
  let tmpDir;
  let prevCwd;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'so-bg-'));
    prevCwd = process.cwd();
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(prevCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const isAlive = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  // The regression this guards: a background `npm run dev` spawns a tree (sh → node → server child).
  // The old cleanup signalled only the leader's positive pid, orphaning the server child, which kept
  // holding its port. cleanupPhase must kill the whole group so the child dies too.
  test('cleanupPhase kills the entire dev-server tree, not just the wrapper', async () => {
    if (process.platform === 'win32') return; // process-group semantics are POSIX-only
    const pm = new ProcessManager();
    pm.setLogFolder(tmpDir);
    const childFile = path.join(tmpDir, 'child.pid');
    // Stand-in for `npm run dev`: the leader spawns a long-lived "server" child (the process the old
    // positive-pid kill left orphaned) and stays up itself.
    const script =
      'const cp=require("child_process");' +
      'const c=cp.spawn("sleep",["600"],{stdio:"ignore"});' +
      `require("fs").writeFileSync(${JSON.stringify(childFile)}, String(c.pid));` +
      'setInterval(()=>{}, 1000);';

    const result = await pm.runCommand({
      cmd: `node -e ${JSON.stringify(script)}`,
      background: true,
      prefix: '',
      startPhase: 'dev phase',
    });
    expect(result.success).toBe(true);

    // Wait for the "server" child to come up and record its pid.
    let childPid = null;
    for (let i = 0; i < 50 && childPid == null; i++) {
      if (fs.existsSync(childFile)) {
        const raw = fs.readFileSync(childFile, 'utf8').trim();
        if (raw) childPid = parseInt(raw, 10);
      }
      if (childPid == null) await new Promise((r) => setTimeout(r, 100));
    }
    expect(Number.isInteger(childPid)).toBe(true);
    expect(isAlive(childPid)).toBe(true);

    await pm.cleanupPhase('dev phase');

    // Give the signals a moment to land before asserting the tree is gone.
    await new Promise((r) => setTimeout(r, 300));
    expect(isAlive(childPid)).toBe(false);
    expect(pm.backgroundProcessesDetails).toHaveLength(0);
  }, 20000);
});
