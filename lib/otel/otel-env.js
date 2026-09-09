/**
 * @file otel-env.js
 * @description Default OTEL file-exporter wiring for `otel`-enabled runs. Only fills in vars the
 * caller hasn't already set, so a CI job (or a developer) pointing at a real OTLP collector via its
 * own OTEL_* env vars is left alone.
 */
import path from 'path';
import { findRepoRoot } from '../workspaces.js';

export function setupOtelEnvDefaults({ logFolder, repoRoot, serviceName } = {}) {
  // `.otel-logs/` lives alongside this gate's other artifacts — the same `--logFolder` that
  // already holds `json_results`/`scripts-orchestrator-logs`/the run-state file — so it inherits
  // whatever scoping (per-workspace, per-gate) the caller already gives that folder. Only when no
  // logFolder is known (e.g. a bare `--aggregate` invocation) do we fall back to the repo root.
  const base = logFolder
    ? path.resolve(logFolder)
    : (repoRoot ?? findRepoRoot() ?? process.cwd());
  if (!process.env.OTEL_TRACES_EXPORTER) {
    process.env.OTEL_TRACES_EXPORTER = 'file';
  }
  if (!process.env.OTEL_EXPORTER_FILE_PATH) {
    process.env.OTEL_EXPORTER_FILE_PATH = path.join(base, '.otel-logs', 'traces.json');
  }
  if (!process.env.OTEL_SERVICE_NAME && serviceName) {
    process.env.OTEL_SERVICE_NAME = serviceName;
  }
  return { base };
}
