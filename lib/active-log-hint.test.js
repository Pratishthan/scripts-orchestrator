import fs from 'fs';
import os from 'os';
import path from 'path';
import { startActiveLogHint } from './active-log-hint.js';

// Builds a throwaway repo: a root package.json declaring `packages/*` workspaces, plus the per-
// workspace log-folder convention the poller scans. Returns the repo root so each test is isolated.
function makeRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'so-activelog-'));
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'root', workspaces: ['packages/*'] }),
  );
  return root;
}

function logDir(root, ws) {
  // discoverWorkspaceDirs only returns workspace dirs that actually contain a package.json
  // (matching npm's own glob semantics), so each test workspace needs one.
  const wsDir = path.join(root, ws);
  fs.mkdirSync(wsDir, { recursive: true });
  fs.writeFileSync(path.join(wsDir, 'package.json'), JSON.stringify({ name: ws }));
  const dir = path.join(wsDir, 'logs', 'scripts-orchestrator-logs');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Write a log file with an explicit mtime so "most recent" is deterministic (no real-time races).
function writeLog(dir, name, contents, mtimeMs) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, contents);
  if (mtimeMs != null) {
    const t = mtimeMs / 1000;
    fs.utimesSync(file, t, t);
  }
  return file;
}

describe('startActiveLogHint', () => {
  test('points at the most-recently-active workspace detail log, repo-relative', () => {
    const root = makeRepo();
    const a = logDir(root, 'packages/a');
    const b = logDir(root, 'packages/b');
    writeLog(a, 'build.log', 'older', 1_000_000);
    writeLog(b, 'lint.log', 'newer', 2_000_000);

    const hints = [];
    const stop = startActiveLogHint({
      repoRoot: root,
      onHint: (rel, ageSec) => hints.push({ rel, ageSec }),
    });
    stop();

    expect(hints).toHaveLength(1);
    expect(hints[0].rel).toBe(path.join('packages/b', 'logs', 'scripts-orchestrator-logs', 'lint.log'));
    expect(typeof hints[0].ageSec).toBe('number');
  });

  test('ignores empty logs, the orchestrator main log and the fan-out summary log', () => {
    const root = makeRepo();
    const a = logDir(root, 'packages/a');
    // Newest mtime but NOT a detail log → must be skipped.
    writeLog(a, 'orchestrator-main.log', 'main', 9_000_000);
    writeLog(a, 'scripts-orchestrator-full:workspaces.log', 'fanout', 8_000_000);
    writeLog(a, 'empty.log', '', 7_000_000);
    // The only real detail log.
    writeLog(a, 'test.log', 'detail', 1_000_000);

    const hints = [];
    const stop = startActiveLogHint({ repoRoot: root, onHint: (rel) => hints.push(rel) });
    stop();

    expect(hints).toEqual([
      path.join('packages/a', 'logs', 'scripts-orchestrator-logs', 'test.log'),
    ]);
  });

  test('emits only when the winning log changes, and a throwing callback never escapes', () => {
    const root = makeRepo();
    const a = logDir(root, 'packages/a');
    writeLog(a, 'build.log', 'x', 1_000_000);

    let calls = 0;
    // First tick fires (and throws — must be swallowed). A manual second tick with no change is a no-op.
    const stop = startActiveLogHint({
      repoRoot: root,
      onHint: () => {
        calls += 1;
        throw new Error('boom');
      },
    });
    stop();

    expect(calls).toBe(1);
  });

  test('no workspaces / no logs → no hint, no throw', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'so-activelog-bare-'));
    const hints = [];
    expect(() =>
      startActiveLogHint({ repoRoot: root, onHint: (rel) => hints.push(rel) })(),
    ).not.toThrow();
    expect(hints).toHaveLength(0);
  });
});
