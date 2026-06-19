import { Orchestrator } from './orchestrator.js';

const baseConfig = (extra = {}) => ({
  phases: [{ name: 'p', parallel: [{ command: 'build' }] }],
  ...extra,
});

describe('Orchestrator command prefix resolution', () => {
  test('defaults to "npm run" when no command_prefix is configured', () => {
    const orch = new Orchestrator(baseConfig());
    expect(orch.commandPrefix).toBe('npm run');
    expect(orch._resolvePrefix({ command: 'build' })).toBe('npm run');
    expect(orch._displayCommand('build', { command: 'build' })).toBe('npm run build');
  });

  test('global command_prefix can be disabled with empty string', () => {
    const orch = new Orchestrator(baseConfig({ command_prefix: '' }));
    expect(orch.commandPrefix).toBe('');
    expect(orch._resolvePrefix({ command: 'ls -la' })).toBe('');
    expect(orch._displayCommand('ls -la', { command: 'ls -la' })).toBe('ls -la');
  });

  test('global command_prefix can be disabled with false or null', () => {
    expect(new Orchestrator(baseConfig({ command_prefix: false })).commandPrefix).toBe('');
    expect(new Orchestrator(baseConfig({ command_prefix: null })).commandPrefix).toBe('');
  });

  test('global command_prefix can be set to a custom runner', () => {
    const orch = new Orchestrator(baseConfig({ command_prefix: 'pnpm run' }));
    expect(orch._resolvePrefix({ command: 'build' })).toBe('pnpm run');
    expect(orch._displayCommand('build', { command: 'build' })).toBe('pnpm run build');
  });

  test('per-command shell:true runs verbatim as a bash command (overrides global)', () => {
    const orch = new Orchestrator(baseConfig({ command_prefix: 'npm run' }));
    const cmd = { command: 'echo hello && ls', shell: true };
    expect(orch._resolvePrefix(cmd)).toBe('');
    expect(orch._displayCommand('echo hello && ls', cmd)).toBe('echo hello && ls');
  });

  test('per-command prefix string overrides the global prefix', () => {
    const orch = new Orchestrator(baseConfig({ command_prefix: 'npm run' }));
    const cmd = { command: 'build', prefix: 'yarn' };
    expect(orch._resolvePrefix(cmd)).toBe('yarn');
    expect(orch._displayCommand('build', cmd)).toBe('yarn build');
  });

  test('per-command empty prefix runs verbatim even when global prefix is set', () => {
    const orch = new Orchestrator(baseConfig({ command_prefix: 'npm run' }));
    const cmd = { command: 'make build', prefix: '' };
    expect(orch._resolvePrefix(cmd)).toBe('');
    expect(orch._displayCommand('make build', cmd)).toBe('make build');
  });

  test('shell:true takes precedence over an explicit prefix', () => {
    const orch = new Orchestrator(baseConfig());
    const cmd = { command: 'echo hi', shell: true, prefix: 'yarn' };
    expect(orch._resolvePrefix(cmd)).toBe('');
  });
});
