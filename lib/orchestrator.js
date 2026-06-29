import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn, spawnSync } from 'child_process';
import { processManager } from './process-manager.js';
import { healthCheck } from './health-check.js';
import { log } from './logger.js';
import { GitCache } from './git-cache.js';
import { renderReportHtml } from './report-html.js';
import { findRepoRoot, writeAggregateReport } from './workspaces.js';
import { startActiveLogHint } from './active-log-hint.js';
import { MemoryGovernor } from './memory-governor.js';
import chalk from 'chalk';

// Exit code used when the run is aborted because host memory ran critically low. Distinct from a
// plain command-failure (1) so callers/CI can tell "your gate failed" from "the box was about to die".
export const MEMORY_ABORT_EXIT_CODE = 137;

export class Orchestrator {
  constructor(
    config,
    startPhase = null,
    logFolder = null,
    phases = null,
    sequential = false,
    force = false,
    metrics = [],
    jsonResultsPath = null,
    htmlResultsPath = null,
  ) {
    this.config = config;
    this.startPhase = startPhase;
    this.logFolder = logFolder;
    this.phases = phases;
    this.sequential = sequential;
    this.force = force;
    this.metrics = Array.isArray(metrics) ? metrics : [];
    // Maximum number of commands a phase runs concurrently. Without this, a phase fires every
    // enabled command at once (Promise.all) — fine on a big CI box, but a smaller machine can't
    // sustain N heavy toolchains in parallel. `max_concurrency` caps the in-flight count:
    //   - 'auto' (default) -> max(1, cpuCount - 1)
    //   - a positive integer -> that exact cap
    //   - 0 / negative / invalid -> treated as 'auto'
    // `--sequential` still wins (it pins the cap to 1). When the cap >= a phase's command count the
    // behaviour is identical to the old unbounded Promise.all, so big machines see no change.
    // CLI `--max-concurrency` overrides the config value (wired in index.js).
    this.maxConcurrency = this._resolveMaxConcurrency(
      config && !Array.isArray(config) ? config.max_concurrency : undefined,
    );
    // Global command prefix. Defaults to 'npm run' so existing configs keep working.
    // Set `command_prefix` to '' / false / null in the config to run commands verbatim
    // as regular shell commands. Per-command `shell: true` or `prefix` overrides this.
    this.commandPrefix = Object.prototype.hasOwnProperty.call(config ?? {}, 'command_prefix')
      ? this._normalizePrefix(config.command_prefix)
      : 'npm run';
    this.jsonResultsPath = jsonResultsPath ?? null;
    this.htmlResultsPath = htmlResultsPath ?? null;
    this.processManager = processManager;
    this.healthCheck = healthCheck;
    this.logger = log;
    // Host-memory safety governor: admission control (hold the next command when free RAM is below a
    // floor) + a hard abort watchdog (kill the child tree and exit non-zero if free RAM stays
    // critically low). Enabled by default; set `memory_guard: false` in the config to opt out, or an
    // object to tune the thresholds. This is the guard `max_concurrency` can't provide — a count cap
    // bounds command *count*, not memory *weight* or the hidden fan of child processes each spawns.
    this.memoryGovernor = new MemoryGovernor(
      config && !Array.isArray(config) ? config.memory_guard : undefined,
      { logger: log },
    );
    this.failedCommands = [];
    this.skippedCommands = [];
    this.skipReasons = new Map(); // Track why commands were skipped
    this.commandTimings = new Map(); // command -> { durationMs, memoryKb?, cpuPercent? }
    this.commandLogPaths = new Map(); // command -> resolved destination log file (absolute)
    this.phaseResults = []; // { name, success, durationMs } per phase run
    this.gitCache = new GitCache(logFolder);
    // track per-command start times for incremental JSON
    this.commandStartTimes = new Map(); // command -> ISO start string
    // events file path derived from jsonResultsPath
    this.eventsPath = this._deriveEventsPath(jsonResultsPath);
    // library-owned run-state file
    this.runStatePath = logFolder
      ? path.join(path.resolve(logFolder), '.scripts-orchestrator-run.json')
      : null;
    // stop fn for the active-log poller (repo-root fan-out only); null when not running
    this._activeLogHintStop = null;
    // post-run hook command (shell string)
    this.postRun = null; // set from config in index.js
    // Memory heat thresholds for the HTML report (fractions of the run's peak). Set from config in
    // index.js; embedded into the results payload so the renderer (and --render) honour them.
    this.memoryHeat = null;
    // Duration heat thresholds for the HTML report (fractions of the run's slowest command). Set from
    // config in index.js; embedded into the results payload so the renderer (and --render) honour them.
    this.durationHeat = null;
    // Periodic hook: shell command fired on an interval while the run is in flight (set in index.js).
    // The library owns only the cadence; the command itself is project-specific (e.g. roll-up render).
    this.periodicHook = null;
    // Declarative npm-workspace roll-up (set from config in index.js). When non-null, the library
    // drives the workspace aggregate IN-PROCESS — no shell-out — using these writeAggregateReport
    // options: the repo-root run owns the periodic cadence + final static report, while a fanned-out
    // workspace run refreshes the roll-up once when it finishes. Replaces wiring a periodic_hook /
    // post_run that shells out to `scripts-orchestrator --aggregate`.
    this.aggregateOptions = null;
    this.periodicIntervalMs = 45000;
    this._periodicTimer = null;
    this._periodicRunning = false;
    this._periodicChild = null;

    // Set the log folder in process manager
    if (logFolder) {
      this.processManager.setLogFolder(logFolder);
    }

    // Flatten commands for easier tracking
    this.allCommands = this.flattenCommands(config);
  }

  flattenCommands(config) {
    // Handle both old array format and new phases format
    if (Array.isArray(config)) {
      return config;
    }

    if (config.phases) {
      return config.phases.flatMap((phase) => phase.parallel || []);
    }

    return [];
  }

  // Resolve a configured/CLI max_concurrency value to a concrete positive integer cap.
  // 'auto' (or anything unparseable / <= 0) maps to max(1, cpuCount - 1); a positive number is
  // floored and used verbatim. Kept side-effect free so it can be reused by the CLI override.
  _resolveMaxConcurrency(value) {
    const auto = Math.max(1, os.cpus().length - 1);
    if (value == null || value === 'auto') return auto;
    const n = Math.floor(Number(value));
    if (!Number.isFinite(n) || n <= 0) return auto;
    return n;
  }

  // Concurrency cap for a single phase. A phase may pin its own `max_concurrency` to
  // run its commands at a different in-flight count than the rest of the run — e.g. a
  // heavy phase whose commands share one resource (a single dev server, a GPU) sets
  // `max_concurrency: 1` to serialise itself while every other phase keeps the global
  // cap and its parallelism. Resolved the same way as the global value, so 'auto' and
  // invalid entries fall back to cpuCount-1 (not silently to the global cap). Phase
  // commands still run through the non-breaking parallel path, so a serial phase
  // continues past a failed command rather than aborting its siblings.
  _phaseConcurrency(phase) {
    if (phase && phase.max_concurrency != null) {
      return this._resolveMaxConcurrency(phase.max_concurrency);
    }
    return this.maxConcurrency;
  }

  // Run `items` through `worker` with at most `limit` in flight at once, preserving result order.
  // This is the bounded-concurrency replacement for `Promise.all(items.map(worker))`: when
  // `limit >= items.length` it is behaviourally identical (everything starts immediately), but a
  // smaller limit keeps only `limit` tasks running and starts the next as each finishes. A worker
  // that rejects rejects the whole batch (matching Promise.all semantics); executeCommand resolves
  // rather than throws, so in practice failures surface as falsy results, not rejections.
  async _runWithConcurrency(items, limit, worker) {
    const results = new Array(items.length);
    let next = 0;
    let inFlight = 0; // commands currently running in this phase — the memory-guard's admission input
    const gov = this.memoryGovernor;
    const runNext = async () => {
      for (;;) {
        // Claim the next index before any await so multiple pool workers cannot all pass
        // `next < items.length`, yield inside waitForHeadroom, and then over-increment `next`
        // (leaving one worker with current >= items.length and items[current] === undefined).
        const current = next++;
        if (current >= items.length) break;
        // Memory-aware admission: a free concurrency slot is necessary but not sufficient. If free
        // host RAM is below the floor, hold here until a running command frees memory rather than
        // piling a heavier slot onto an already-pressured box. No-op (no await stall) when the guard
        // is disabled or memory is healthy — see MemoryGovernor.waitForHeadroom.
        if (gov && gov.enabled) {
          await gov.waitForHeadroom(inFlight);
        }
        inFlight += 1;
        try {
          results[current] = await worker(items[current], current);
        } finally {
          inFlight -= 1;
        }
      }
    };
    const pool = Array.from({ length: Math.min(limit, items.length) }, () => runNext());
    await Promise.all(pool);
    return results;
  }

  _deriveEventsPath(jsonResultsPath) {
    if (!jsonResultsPath || jsonResultsPath === '-') return null;
    return jsonResultsPath.replace(/\.json$/, '') + '-events.ndjson';
  }

  // write current run state atomically
  _writeRunState(extra = {}) {
    if (!this.runStatePath) return;
    const state = {
      startedAt: this.runStartedAt ? new Date(this.runStartedAt).toISOString() : new Date().toISOString(),
      pid: process.pid,
      ...extra,
    };
    const tmp = this.runStatePath + '.tmp';
    try {
      fs.mkdirSync(path.dirname(this.runStatePath), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', 'utf8');
      fs.renameSync(tmp, this.runStatePath);
    } catch { /* non-fatal */ }
  }

  // remove run-state file on run end
  _clearRunState() {
    if (!this.runStatePath) return;
    try { fs.unlinkSync(this.runStatePath); } catch { /* ignore */ }
  }

  // append a structured NDJSON event
  _appendEvent(type, data = {}) {
    if (!this.eventsPath) return;
    const line = JSON.stringify({ type, timestamp: new Date().toISOString(), ...data });
    try {
      fs.appendFileSync(this.eventsPath, line + '\n', 'utf8');
    } catch {
      // non-fatal: don't let event logging break the run
    }
  }

  // atomically write current run state (completed + in-flight commands) to json_results.
  // `terminal` marks a final write for a run that ended WITHOUT reaching its natural completion
  // (interrupt / memory abort): the top-level `success` becomes `false` (not the in-progress
  // `null` sentinel) so the report — and the aggregate's inProgress auto-detection — reads the run
  // as over, while any command still in flight keeps its own `success:null` so it renders as
  // INTERRUPTED rather than a false pass. The caller clears the run-state marker, so a terminal
  // write does not rewrite it.
  _writePartialResults(terminal = false) {
    if (this.jsonResultsPath == null || this.jsonResultsPath === '-') return;
    const outPath = this.jsonResultsPath || './scripts-orchestrator-results.json';

    const commands = [];

    const buildEntry = (command, phaseName) => {
      const timing = this.commandTimings.get(command);
      const startedAt = this.commandStartTimes.get(command);
      const skipped = this.skippedCommands.includes(command);
      const done = timing != null || skipped;

      if (!done && startedAt) {
        return {
          command,
          ...(phaseName ? { phase: phaseName } : {}),
          success: null,
          startedAt,
          ...this._logFileField(command),
        };
      }
      if (!done) return null; // not yet started — omit

      const skipReason = skipped ? (this.skipReasons.get(command) ?? null) : null;
      const success =
        !this.failedCommands.includes(command) &&
        (skipReason === null ||
          skipReason === 'disabled' ||
          skipReason === 'optional_phase_not_requested' ||
          skipReason === 'before_start_phase');
      return {
        command,
        ...(phaseName ? { phase: phaseName } : {}),
        success,
        ...(startedAt ? { startedAt } : {}),
        ...(timing?.durationMs != null ? { durationMs: timing.durationMs } : {}),
        ...(this.metrics.includes('memory') ? { memoryKb: timing?.memoryKb ?? null } : {}),
        ...(this.metrics.includes('cpu') ? { cpuPercent: timing?.cpuPercent ?? null } : {}),
        ...this._logFileField(command),
        ...(skipReason ? { skipReason } : {}),
      };
    };

    if (Array.isArray(this.config)) {
      for (const { command } of this.config) {
        const entry = buildEntry(command, null);
        if (entry) commands.push(entry);
      }
    } else if (this.config.phases) {
      for (const phase of this.config.phases) {
        for (const { command } of (phase.parallel || [])) {
          const entry = buildEntry(command, phase.name);
          if (entry) commands.push(entry);
        }
      }
    }

    const payload = {
      // in-progress sentinel (null) → replaced by writeJsonResults on natural completion; a
      // terminal write (interrupt / abort) records `false` so the run reads as ended, not running.
      success: terminal ? false : null,
      // Mark a terminal write as an interruption so the report shows a distinct "Interrupted" banner
      // rather than "Failed" — it's non-success (success stays false) but not a gate failure.
      ...(terminal ? { interrupted: true } : {}),
      timestamp: new Date().toISOString(),
      ...(this.startTime ? { overallDurationMs: Date.now() - this.startTime } : {}), // elapsed so far
      commands,
      ...(this.config.phases && this.phaseResults.length > 0 ? { phases: this.phaseResults } : {}),
      ...(this.memoryHeat ? { memoryHeat: this.memoryHeat } : {}),
      ...(this.durationHeat ? { durationHeat: this.durationHeat } : {}),
    };

    const tmpPath = outPath + '.tmp';
    try {
      fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
      fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2), 'utf8');
      fs.renameSync(tmpPath, outPath);
    } catch (err) {
      this.logger.verbose(`Partial results write failed: ${err.message}`);
    }

    // Incrementally refresh the HTML report too (like merge-report:live), so a live,
    // up-to-date report exists from the first command onward and survives interruption.
    // Skip the stdout sink ('-') to avoid spamming the console on every update.
    if (this.htmlResultsPath != null && this.htmlResultsPath !== '-') {
      try {
        this.writeHtmlResults(payload);
      } catch (err) {
        this.logger.verbose(`Partial HTML write failed: ${err.message}`);
      }
    }

    // A terminal write belongs to a run that is ending; the caller removes the run-state marker
    // right after, so don't resurrect it here.
    if (terminal) return;

    // keep run-state file in sync with current active commands and phase
    const inFlight = commands.filter(c => c.success === null).map(c => c.command);
    const currentPhase = commands.length > 0 ? (commands[commands.length - 1].phase ?? null) : null;
    this._writeRunState({
      activeCommand: inFlight.length === 1 ? inFlight[0] : (inFlight.length > 1 ? inFlight : null),
      phase: currentPhase,
    });
  }

  formatDuration(ms) {
    if (ms < 1000) return `${ms}ms`;
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    if (minutes > 0) {
      return `${minutes}m ${remainingSeconds}s`;
    }
    return `${seconds}s`;
  }

  // Resolve a command's destination log file as a path relative to cwd (absolute if outside),
  // returned as a spreadable object so callers can inline it into result entries.
  _logFileField(command) {
    const p = this.commandLogPaths.get(command);
    if (!p) return {};
    let rel = p;
    try {
      const r = path.relative(process.cwd(), p);
      if (r && !r.startsWith('..')) rel = r;
    } catch {
      // keep absolute path on any failure
    }
    return { logFile: rel };
  }

  // The important output files this run produces, as [label, absolutePath] pairs.
  // Excludes stdout sinks ('-'). Used to announce report locations in the logs.
  _reportFiles() {
    const files = [];
    if (this.jsonResultsPath != null && this.jsonResultsPath !== '-') {
      files.push(['JSON results', path.resolve(this.jsonResultsPath || './scripts-orchestrator-results.json')]);
    }
    if (this.htmlResultsPath != null && this.htmlResultsPath !== '-') {
      files.push(['HTML report', path.resolve(this.htmlResultsPath || './scripts-orchestrator-results.html')]);
    }
    if (this.eventsPath) {
      files.push(['Events (NDJSON)', path.resolve(this.eventsPath)]);
    }
    return files;
  }

  // Announce report file locations in the logs (prefix e.g. 'Live reports' / 'Reports written').
  _announceReportFiles(prefix) {
    const files = this._reportFiles();
    if (files.length === 0) return;
    this.logger.info(`📄 ${prefix}:`);
    for (const [label, file] of files) {
      this.logger.info(`   • ${label}: ${file}`);
    }
  }

  // Normalize a prefix value into a clean string. false/null/'' all mean "no prefix"
  // (run the command verbatim); any string is trimmed.
  _normalizePrefix(value) {
    if (value === false || value === null || value === undefined) return '';
    return String(value).trim();
  }

  // Resolve the effective prefix for a single command.
  // Precedence: per-command `shell: true` (raw) > per-command `prefix` > global commandPrefix.
  _resolvePrefix(commandConfig = {}) {
    if (commandConfig.shell === true) return '';
    if (Object.prototype.hasOwnProperty.call(commandConfig, 'prefix')) {
      return this._normalizePrefix(commandConfig.prefix);
    }
    return this.commandPrefix;
  }

  // Format a command for display, honoring its resolved prefix.
  _displayCommand(command, commandConfig = {}) {
    const prefix = this._resolvePrefix(commandConfig);
    return prefix ? `${prefix} ${command}` : command;
  }

  async executeCommand(commandConfig, visited = new Set(), phaseName = null) {
    const {
      command,
      dependencies = [],
      background = false,
      status = 'enabled',
      log,
      logFile,
      attempts = 1,
      retry_command,
      should_retry,
      process_tracking = false,
      health_check,
      kill_command,
      env,
      // A background process declared `persist: true` is NOT torn down when its phase ends — it
      // survives until the whole run finishes. Use it for a shared dependency (e.g. one dev server)
      // that later phases run against. Phase-scoped background processes (the default) are killed at
      // the end of the phase that started them.
      persist = false,
    } = commandConfig;

    const startTime = Date.now();
    // Effective invocation prefix for this command ('' => run verbatim as a shell command).
    const prefix = this._resolvePrefix(commandConfig);

    // Record the destination log file for this command (honors per-command override).
    // Done early so even disabled/skipped commands report where output would land.
    this.commandLogPaths.set(command, this.processManager.getLogPath(command, log || logFile));

    const setTiming = (durationMs, memoryKb = null, cpuPercent = null) => {
      this.commandTimings.set(command, { durationMs, memoryKb, cpuPercent });
    };

    // Check for circular dependencies
    if (visited.has(command)) {
      this.logger.error(
        `Circular dependency detected: ${Array.from(visited).join(' -> ')} -> ${command}`,
      );
      this.failedCommands.push(command);
      setTiming(Date.now() - startTime);
      return false;
    }
    visited.add(command);

    // Skip execution if the command is disabled
    if (status === 'disabled') {
      this.logger.warn(`Skipping: ${this._displayCommand(command, commandConfig)} (status: disabled)`);
      this.skippedCommands.push(command);
      this.skipReasons.set(command, 'disabled');
      setTiming(Date.now() - startTime);
      visited.delete(command);
      return true;
    }

    const checkUrl = health_check?.url;
    if (checkUrl) {
      this.logger.startEphemeral(
        `check_${checkUrl}`,
        chalk.blue(`[INFO] ⏳ Checking if ${checkUrl} is already available...`),
      );
      const urlAvailable = await this.healthCheck.waitForUrl({
        url: checkUrl,
        maxAttempts: 1,
        silent: true,
      });

      if (!urlAvailable) {
        this.logger.stopEphemeral(`check_${checkUrl}`);
      } else {
        this.logger.stopEphemeral(
          `check_${checkUrl}`,
          `✅ ${checkUrl} is already available. Skipping ${command} start.`,
        );
        this.processManager.addBackgroundProcess({
          command,
          url: checkUrl,
          startedByScript: false,
          process_tracking,
          kill_command,
          prefix,
          phase: phaseName,
          persist,
        });
        setTiming(Date.now() - startTime);
        visited.delete(command);
        return true;
      }
    }

    // Execute dependencies first. Dependencies inherit their parent command's phase so any
    // background process they start (e.g. a `npm run dev` server) is torn down when that phase ends.
    for (const dependency of dependencies) {
      const dependencySuccess = await this.executeCommand(dependency, visited, phaseName);
      if (!dependencySuccess) {
        this.logger.error(`Skipping ${command} due to failed dependency`);
        this.skippedCommands.push(command);
        this.skipReasons.set(command, 'failed_dependency');
        setTiming(Date.now() - startTime);
        visited.delete(command);
        return false;
      }

      if (dependency.health_check?.url) {
        const urlAvailable = await this.healthCheck.waitForUrl({
          url: dependency.health_check.url,
          maxAttempts: dependency.health_check?.max_attempts || 20,
          interval: dependency.health_check?.interval || 2000,
        });
        if (!urlAvailable) {
          this.skippedCommands.push(command);
          this.skipReasons.set(command, 'failed_dependency');
          setTiming(Date.now() - startTime);
          visited.delete(command);
          return false;
        }
        if (dependency.wait) {
          this.logger.verbose(`Waiting ${dependency.wait}ms`);
          await new Promise((resolve) => {
            setTimeout(() => {
              this.logger.verbose(
                `Resolving after a wait of ${dependency.wait}ms`,
              );
              resolve(true);
            }, dependency.wait);
          });
        }
      }
    }

    // record start and emit event
    this.commandStartTimes.set(command, new Date().toISOString());
    this._appendEvent('command_start', { command, phase: phaseName, scope: 'workspace' });
    this._writePartialResults();

    // Execute the main command with retries
    let result = false;
    let commandOutput = '';
    let commandFailed = false;
    let lastRunResult = null;

    for (let attempt = 1; attempt <= attempts; attempt++) {
      if (attempt > 1) {
        this.logger.warn(
          `Retrying ${command} (attempt ${attempt}/${attempts})`,
        );
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }

      const runResult = await this.processManager.runCommand({
        cmd: attempt === 1 ? command : retry_command || command,
        logFile: log || logFile, // Prefer 'log' key over 'logFile' for backwards compatibility
        background,
        healthCheck: health_check,
        kill_command,
        isRetry: attempt > 1,
        env,
        reportTime: this.metrics.includes('time'),
        reportMemory: this.metrics.includes('memory'),
        reportCpu: this.metrics.includes('cpu'),
        prefix,
        startPhase: phaseName,
        persist,
      });
      lastRunResult = runResult;
      const { success, output } = runResult;
      commandOutput = output;
      result = success;

      if (result) {
        // Remove from failed commands if it was there
        this.failedCommands = this.failedCommands.filter(
          (cmd) => cmd !== command,
        );
        commandFailed = false;
        break;
      } else if (attempt < attempts) {
        if (should_retry && !should_retry(commandOutput)) {
          this.logger.warn(
            `${command} failed but doesn't meet retry criteria. Skipping retry.`,
          );
          commandFailed = true;
          break;
        }
        this.logger.error(
          `Attempt ${attempt}/${attempts} failed for ${command}`,
        );
        commandFailed = true;
      } else {
        commandFailed = true;
      }
    }

    if (commandFailed) {
      this.failedCommands.push(command);

      // Cleanup any background processes for this failed command
      if (background) {
        this.logger.warn(
          `Command ${command} failed after all attempts. Cleaning up background processes.`,
        );
        try {
          await this.processManager.cleanupCommand(command);
        } catch (cleanupError) {
          this.logger.error(
            `Failed to cleanup processes for ${command}: ${cleanupError.message}`,
          );
        }
      }
    }

    const totalDurationMs = Date.now() - startTime;
    setTiming(totalDurationMs, lastRunResult?.memoryKb ?? null, lastRunResult?.cpuPercent ?? null);
    // emit completion event and write incremental results
    this._appendEvent('command_end', { command, phase: phaseName, success: result, durationMs: totalDurationMs });
    this._writePartialResults();
    visited.delete(command);
    return result;
  }

  summarizeResults() {
    let hasFailures = false;

    // Check if any command failed or was skipped due to failure
    this.allCommands.forEach(({ command }) => {
      if (this.failedCommands.includes(command)) {
        hasFailures = true;
      } else if (this.skippedCommands.includes(command)) {
        const skipReason = this.skipReasons.get(command);
        if (
          skipReason === 'failed_dependency' ||
          skipReason === 'after_phase_failure'
        ) {
          hasFailures = true;
        }
      }
    });

    if (hasFailures) {
      this.logger.error('\n❌ Some commands failed or were skipped.');
    } else {
      this.logger.success('\n🎉 All commands executed successfully!');
    }
  }

  writeJsonResults(hasFailures) {
    const overallDurationMs = this.startTime ? Date.now() - this.startTime : undefined;

    const commands = [];
    if (Array.isArray(this.config)) {
      this.config.forEach(({ command }) => {
        const timing = this.commandTimings.get(command);
        const skipReason = this.skippedCommands.includes(command)
          ? this.skipReasons.get(command) ?? null
          : null;
        const success =
          !this.failedCommands.includes(command) &&
          (skipReason === null ||
            skipReason === 'disabled' ||
            skipReason === 'optional_phase_not_requested' ||
            skipReason === 'before_start_phase');
        const entry = {
          command,
          success,
          ...(this.commandStartTimes.has(command)
            ? { startedAt: this.commandStartTimes.get(command) }
            : {}),
          ...(timing?.durationMs != null ? { durationMs: timing.durationMs } : {}),
          ...(this.metrics.includes('memory')
            ? { memoryKb: timing?.memoryKb ?? null }
            : {}),
          ...(this.metrics.includes('cpu')
            ? { cpuPercent: timing?.cpuPercent ?? null }
            : {}),
          ...this._logFileField(command),
          ...(skipReason ? { skipReason } : {}),
        };
        commands.push(entry);
      });
    } else if (this.config.phases) {
      this.config.phases.forEach((phase) => {
        (phase.parallel || []).forEach(({ command }) => {
          const timing = this.commandTimings.get(command);
          const skipReason = this.skippedCommands.includes(command)
            ? this.skipReasons.get(command) ?? null
            : null;
          const success =
            !this.failedCommands.includes(command) &&
            (skipReason === null ||
              skipReason === 'disabled' ||
              skipReason === 'optional_phase_not_requested' ||
              skipReason === 'before_start_phase');
          const entry = {
            command,
            phase: phase.name,
            success,
            ...(this.commandStartTimes.has(command)
              ? { startedAt: this.commandStartTimes.get(command) }
              : {}),
            ...(timing?.durationMs != null ? { durationMs: timing.durationMs } : {}),
            ...(this.metrics.includes('memory')
              ? { memoryKb: timing?.memoryKb ?? null }
              : {}),
            ...(this.metrics.includes('cpu')
              ? { cpuPercent: timing?.cpuPercent ?? null }
              : {}),
            ...this._logFileField(command),
            ...(skipReason ? { skipReason } : {}),
          };
          commands.push(entry);
        });
      });
    }

    const payload = {
      success: !hasFailures,
      timestamp: new Date().toISOString(),
      ...(overallDurationMs != null ? { overallDurationMs } : {}),
      commands,
      ...(this.config.phases && this.phaseResults.length > 0
        ? { phases: this.phaseResults }
        : {}),
      ...(this.memoryHeat ? { memoryHeat: this.memoryHeat } : {}),
      ...(this.durationHeat ? { durationHeat: this.durationHeat } : {}),
    };

    const json = JSON.stringify(payload, null, 2);
    if (this.jsonResultsPath === '-') {
      console.log(json);
    } else {
      const outPath = this.jsonResultsPath || './scripts-orchestrator-results.json';
      fs.writeFileSync(outPath, json, 'utf8');
      this.logger.verbose(`Wrote results to ${outPath}`);
    }

    if (this.htmlResultsPath != null) {
      this.writeHtmlResults(payload);
    }

    // Announce the important output files so they're easy to find in the logs.
    this._announceReportFiles('Reports written');
  }

  writeHtmlResults(payload) {
    const html = renderReportHtml(payload);
    if (this.htmlResultsPath === '-') {
      console.log(html);
      return;
    }
    const outPath = this.htmlResultsPath || './scripts-orchestrator-results.html';
    // Atomic write so live reloaders (incremental refresh) never read a half-written file.
    const tmpPath = outPath + '.tmp';
    fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
    fs.writeFileSync(tmpPath, html, 'utf8');
    fs.renameSync(tmpPath, outPath);
    this.logger.verbose(`Wrote HTML report to ${outPath}`);
  }

  async run() {
    this.startTime = Date.now();
    this.runStartedAt = this.startTime;
    // write initial run-state at start
    this._writeRunState({ phase: null, activeCommand: null });
    try {
      // Check if we should skip execution based on git state (unless forced)
      if (!this.force) {
        const shouldSkip = await this.gitCache.shouldSkipExecution();
        if (shouldSkip) {
          this.logger.success('🎉 No changes detected, skipping execution!');
          this.logger.info('💡 To force execution, use: --force');
          process.exit(0);
        }
      } else {
        this.logger.info(
          '⚡ Force execution enabled, skipping git cache check',
        );
      }

      let hasFailures = false;
      let phaseFailed = false;
      let startPhaseFound = false;

      // Announce where the live report files will be written (they update incrementally,
      // so they can be opened to watch progress while the run is in flight).
      this._announceReportFiles('Live reports (updated as the run progresses)');

      // Start the periodic roll-up hook (no-op unless configured).
      this._startPeriodicHook();

      // Point tailers at the most-active workspace log during the fan-out (no-op off the repo root).
      this._startActiveLogHint();

      // Arm the host-memory abort watchdog (no-op when memory_guard is disabled). It runs for the
      // whole run and fires at most once if free RAM stays critically low for a sustained window.
      if (this.memoryGovernor.enabled) {
        this.logger.info(`🧠 ${this.memoryGovernor.describe()}`);
        this.logger.info(
          '   ↳ Too strict? Disable it for this run with --no-memory-guard, turn it off in config ' +
            'with `memory_guard: false`, or relax the thresholds via ' +
            '`memory_guard: { minFreeRatio, abortFreeRatio, sustainedMs }` (lower the ratios / raise sustainedMs).',
        );
        this.memoryGovernor.startWatchdog((info) => {
          // Fire-and-forget: the handler ends in process.exit, so we don't await it here.
          this._abortOnMemoryPressure(info);
        });
      }

      // Handle both old array format and new phases format
      if (Array.isArray(this.config)) {
        // Legacy: Run all commands in parallel or sequential based on flag
        if (this.sequential) {
          this.logger.info('🔄 Running in sequential mode');
          const results = [];
          for (const commandConfig of this.config) {
            const result = await this.executeCommand(commandConfig);
            results.push(result);
            if (!result) {
              hasFailures = true;
              break; // Stop on first failure in sequential mode
            }
          }
        } else {
          const results = await this._runWithConcurrency(
            this.config,
            this.maxConcurrency,
            (commandConfig) => this.executeCommand(commandConfig),
          );
          hasFailures = results.some((result) => !result);
        }
      } else if (this.config.phases) {
        // New: Run phases sequentially, commands within phases in parallel or sequential based on flag
        if (this.sequential) {
          this.logger.info('🔄 Running in sequential mode');
        } else {
          this.logger.info(
            `🧮 Max concurrency: ${this.maxConcurrency} (of ${os.cpus().length} CPUs) — commands per phase run at most this many at a time`,
          );
        }

        for (const phase of this.config.phases) {
          // Check if we should start from this phase
          if (this.startPhase && !startPhaseFound) {
            if (phase.name === this.startPhase) {
              startPhaseFound = true;
              this.logger.info(`\n🎯 Starting from phase: ${phase.name}`);
            } else {
              // Mark all commands in previous phases as skipped
              phase.parallel.forEach(({ command }) => {
                this.skippedCommands.push(command);
                this.skipReasons.set(command, 'before_start_phase');
                this.commandTimings.set(command, { durationMs: 0, memoryKb: null, cpuPercent: null });
              });
              continue;
            }
          }

          // Check if this is an optional phase that should be skipped
          if (
            phase.optional === true &&
            this.phases &&
            !this.phases.includes(phase.name)
          ) {
            this.logger.info(
              `\n⏭️  Skipping optional phase: ${phase.name} (not explicitly requested)`,
            );
            // Mark all commands in this phase as skipped
            phase.parallel.forEach(({ command }) => {
              this.skippedCommands.push(command);
              this.skipReasons.set(command, 'optional_phase_not_requested');
              this.commandTimings.set(command, { durationMs: 0, memoryKb: null, cpuPercent: null });
            });
            continue;
          }

          if (phaseFailed) {
            // Mark all commands in remaining phases as skipped
            phase.parallel.forEach(({ command }) => {
              this.skippedCommands.push(command);
              this.skipReasons.set(command, 'after_phase_failure');
              this.commandTimings.set(command, { durationMs: 0, memoryKb: null, cpuPercent: null });
            });
            continue;
          }

          const phaseStartTime = Date.now();

          let results;
          if (this.sequential) {
            // Run commands sequentially
            results = [];
            for (const commandConfig of phase.parallel) {
              const result = await this.executeCommand(commandConfig, new Set(), phase.name);
              results.push(result);
              if (!result) {
                // In sequential mode, stop phase execution on first failure
                break;
              }
            }
          } else {
            // Run commands in parallel, but never more than the cap at once so a smaller
            // machine isn't asked to host every command's toolchain simultaneously. The
            // cap is per-phase: a phase may pin its own `max_concurrency` (e.g. force
            // serial execution of commands that share one resource) without changing the
            // limit any other phase runs at.
            const phaseConcurrency = this._phaseConcurrency(phase);
            if (phaseConcurrency !== this.maxConcurrency) {
              this.logger.info(
                `   ↳ phase concurrency: ${phaseConcurrency} (phase "${phase.name}" overrides the ${this.maxConcurrency} default)`,
              );
            }
            results = await this._runWithConcurrency(
              phase.parallel,
              phaseConcurrency,
              (commandConfig) => this.executeCommand(commandConfig, new Set(), phase.name),
            );
          }

          const phaseHasFailures = results.some((result) => !result);
          const phaseDurationMs = Date.now() - phaseStartTime;
          const phaseDurationStr = this.metrics.includes('time')
            ? `(${this.formatDuration(phaseDurationMs)})`
            : '';

          this.phaseResults.push({
            name: phase.name,
            success: !phaseHasFailures,
            durationMs: phaseDurationMs,
          });

          if (phaseHasFailures) {
            hasFailures = true;
            phaseFailed = true;
            this.logger.stopPhase(phase.name, false, phaseDurationStr);
          } else {
            this.logger.stopPhase(phase.name, true, phaseDurationStr);
          }

          // Tear down any background dependencies this phase started (e.g. a `npm run dev` server),
          // on both success and failure, so they don't leak into later phases or past the run. A
          // dependency declared `persist: true` is left running and reclaimed by run-end cleanup().
          try {
            await this.processManager.cleanupPhase(phase.name);
          } catch (cleanupError) {
            this.logger.error(
              `Failed to clean up background processes for phase ${phase.name}: ${cleanupError.message}`,
            );
          }
        }
      }

      // Validate start phase if specified
      if (this.startPhase && !startPhaseFound) {
        const availablePhases = this.config.phases
          .map((p) => p.name)
          .join(', ');
        this.logger.error(
          `❌ Start phase "${this.startPhase}" not found. Available phases: ${availablePhases}`,
        );
        process.exit(1);
      }

      // Validate phases if specified
      if (this.phases) {
        const availablePhases = this.config.phases.map((p) => p.name);
        const invalidPhases = this.phases.filter(
          (phase) => !availablePhases.includes(phase),
        );
        if (invalidPhases.length > 0) {
          this.logger.error(
            `❌ Invalid phases specified: ${invalidPhases.join(', ')}. Available phases: ${availablePhases.join(', ')}`,
          );
          process.exit(1);
        }
      }

      // Check final status
      // Only count skipped commands as failures if they're due to dependency issues or phase failures
      const failureSkippedCommands = Array.from(this.skipReasons.entries())
        .filter(
          ([, reason]) =>
            reason === 'failed_dependency' || reason === 'after_phase_failure',
        )
        .map(([command]) => command);

      hasFailures =
        hasFailures ||
        this.failedCommands.length > 0 ||
        failureSkippedCommands.length > 0;

      // The run reached its natural end — disarm the memory watchdog so it can't fire during the
      // shutdown/cleanup window, and stop the fan-out active-log poller.
      this.memoryGovernor.stopWatchdog();
      this._stopActiveLogHint();

      // Add a small delay to ensure all processes have finished
      await new Promise((resolve) => setTimeout(resolve, 1000));

      this.summarizeResults();

      // Cleanup before exit since finally blocks don't run after process.exit()
      try {
        await this.processManager.cleanup();
      } catch (error) {
        this.logger.error(`Cleanup failed: ${error.message}`);
      }

      // Log overall time after cleanup has finished (only when metrics include time)
      if (this.startTime && this.metrics.includes('time')) {
        const overallDuration = Date.now() - this.startTime;
        this.logger.printMessage(() =>
          console.log(
            chalk.cyan(
              `[INFO] ⏱️  Overall time taken: ${this.formatDuration(overallDuration)}`,
            ),
          ),
        );
      }

      // emit run_end event; final JSON written by writeJsonResults (replaces partial)
      const runDurationMs = this.startTime ? Date.now() - this.startTime : undefined;
      this._appendEvent('run_end', { success: !hasFailures, ...(runDurationMs != null ? { durationMs: runDurationMs } : {}) });

      // Write JSON results if requested
      if (this.jsonResultsPath != null) {
        this.writeJsonResults(hasFailures);
      }

      // clear run-state file — run is done
      this._clearRunState();

      // Final roll-up (synchronous) AFTER run-state is cleared, so the aggregate reflects the
      // finished run (an in-flight marker would otherwise make the final report read as running).
      this._firePeriodicHookFinal();

      // run post_run hook after results are written
      this._runPostRunHook(hasFailures);

      // Update git cache on successful execution
      if (!hasFailures) {
        await this.gitCache.updateCache();
      }

      // Force exit with appropriate status
      if (hasFailures) {
        this.logger.info('Exiting with failure status...');
        process.exit(1);
      } else {
        this.logger.info('Exiting with success status...');
        process.exit(0);
      }
    } catch (error) {
      this.logger.error(`Orchestrator failed: ${error.message}`);

      // Stop periodic ticks + active-log hint + memory watchdog on error.
      this._stopPeriodicHook();
      this._stopActiveLogHint();
      this.memoryGovernor.stopWatchdog();

      // clear run-state on error too
      this._clearRunState();

      // Cleanup on error
      try {
        await this.processManager.cleanup();
      } catch (cleanupError) {
        this.logger.error(`Cleanup failed: ${cleanupError.message}`);
      }

      process.exit(1);
    }
  }

  // Finalize the run after an external termination (SIGINT/SIGTERM/SIGQUIT/SIGHUP) or an uncaught
  // fault. The run did not reach its natural end, so the LIBRARY — not the consumer's run wrapper —
  // owns leaving everything in a consistent, non-"running" state:
  //   • tear down the periodic cadence, active-log hint and memory watchdog,
  //   • kill the child process tree (processManager.cleanup),
  //   • persist a TERMINAL results JSON (top-level success=false; any in-flight command stays
  //     success:null → rendered INTERRUPTED, never a false pass),
  //   • remove the run-state marker, and
  //   • write one final STATIC workspace roll-up (inProgress=false — the run is over, so the report
  //     must not keep auto-refreshing or show RUNNING).
  // Best-effort and safe to call once: each step is guarded so a failure in one still runs the rest.
  // This replaces the run wrapper's interrupt fallback, which re-fired an auto-detecting aggregate
  // and so re-flagged a killed run as RUNNING (because the root results JSON still held the
  // in-progress success:null sentinel).
  async finalizeInterrupted() {
    this._stopPeriodicHook();
    this._stopActiveLogHint();
    this.memoryGovernor.stopWatchdog();
    try {
      await this.processManager.cleanup();
    } catch (err) {
      this.logger.error(`Cleanup failed: ${err.message}`);
    }
    try {
      this._writePartialResults(true); // terminal: top-level success=false
    } catch (err) {
      this.logger.verbose(`Terminal results write failed: ${err.message}`);
    }
    this._clearRunState();
    // The run was killed — force a static, non-refreshing roll-up regardless of repo-root vs.
    // fanned-out workspace process (every process in the tree is being torn down).
    if (this.aggregateOptions) this._fireAggregate(false);
  }

  // Start the fan-out active-log poller — only meaningful on the repo-root run, where the root's own
  // logs carry just the task-runner summary and the real detail is under each workspace. A workspace
  // run gets per-command "Tail:" hints from the process manager instead (no fan-out to point into).
  _startActiveLogHint() {
    if (this._activeLogHintStop) return;
    if (!this._isRepoRootRun()) return;
    try {
      const repoRoot = findRepoRoot(process.cwd()) || process.cwd();
      this._activeLogHintStop = startActiveLogHint({
        repoRoot,
        onHint: (rel, ageSec) =>
          this.logger.info(`Active log (${ageSec}s ago): ${rel}`),
      });
    } catch (err) {
      this.logger.verbose(`[active-log-hint] disabled: ${err.message}`);
    }
  }

  // Tear down the active-log poller (idempotent).
  _stopActiveLogHint() {
    if (this._activeLogHintStop) {
      try {
        this._activeLogHintStop();
      } catch {
        /* ignore */
      }
      this._activeLogHintStop = null;
    }
  }

  // Is this process the repo-root orchestrator run (vs. a fanned-out workspace run)? The root run
  // owns the periodic roll-up cadence and the final static report; a workspace run only refreshes
  // the aggregate once as it finishes (mirrors the old root periodic_hook / workspace post_run split).
  _isRepoRootRun() {
    try {
      const root = findRepoRoot(process.cwd());
      return root != null && path.resolve(process.cwd()) === root;
    } catch {
      return false;
    }
  }

  // Roll up every workspace's results into the aggregate report, in-process. inProgress is left
  // undefined (auto-detected from the root run-state file) except for the root run's final fire.
  _fireAggregate(inProgress) {
    try {
      const opts = inProgress == null
        ? this.aggregateOptions
        : { ...this.aggregateOptions, inProgress };
      const { jsonPath } = writeAggregateReport(opts);
      this.logger.verbose(`[aggregate] rolled up workspaces → ${jsonPath}`);
    } catch (err) {
      this.logger.warn(`[aggregate] roll-up failed: ${err.message}`);
    }
  }

  // Periodic hook: start the interval timer (fires once promptly, then every interval).
  _startPeriodicHook() {
    if (this._periodicTimer) return;
    if (!this.periodicHook && !this.aggregateOptions) return;
    // In-process aggregate: only the repo-root run drives the periodic cadence. A fanned-out
    // workspace run refreshes the roll-up just once, at the end (see _firePeriodicHookFinal).
    if (this.aggregateOptions && !this.periodicHook && !this._isRepoRootRun()) return;
    this.logger.info(
      this.periodicHook
        ? `⏱️  Periodic report hook every ${Math.round(this.periodicIntervalMs / 1000)}s: ${this.periodicHook}`
        : `⏱️  Periodic workspace roll-up every ${Math.round(this.periodicIntervalMs / 1000)}s (in-process)`,
    );
    this._firePeriodicTick(); // prompt first roll-up so an initial aggregate exists
    this._periodicTimer = setInterval(() => this._firePeriodicTick(), this.periodicIntervalMs);
    if (this._periodicTimer.unref) this._periodicTimer.unref();
  }

  // Fire the periodic hook asynchronously, with an overlap guard so slow hooks don't pile up.
  _firePeriodicTick() {
    // In-process aggregate path: synchronous, so no overlap guard needed.
    if (this.aggregateOptions && !this.periodicHook) {
      this._fireAggregate(undefined);
      return;
    }
    if (!this.periodicHook || this._periodicRunning) {
      if (this._periodicRunning) {
        this.logger.verbose('[periodic_hook] previous invocation still running; skipping tick');
      }
      return;
    }
    this._periodicRunning = true;
    try {
      const child = spawn(this.periodicHook, {
        shell: true,
        stdio: 'ignore',
        cwd: process.cwd(),
        env: { ...process.env, SCRIPTS_ORCHESTRATOR_PERIODIC: '1' },
      });
      this._periodicChild = child;
      child.on('exit', (code) => {
        this._periodicRunning = false;
        this._periodicChild = null;
        if (code && code !== 0) this.logger.verbose(`[periodic_hook] exited with code ${code}`);
      });
      child.on('error', (err) => {
        this._periodicRunning = false;
        this._periodicChild = null;
        this.logger.warn(`[periodic_hook] failed: ${err.message}`);
      });
    } catch (err) {
      this._periodicRunning = false;
      this.logger.warn(`[periodic_hook] error: ${err.message}`);
    }
  }

  // Host memory ran critically low for the sustained window — fail loud and clean instead of letting
  // the box swap to death (or the OS OOM-killer pick a victim). Kill the child process tree, persist
  // whatever partial results we have, and exit with a distinct non-zero code + actionable diagnostic.
  async _abortOnMemoryPressure(info) {
    this.logger.error(
      `\n🛑 [memory-guard] ABORTING: host available RAM stayed at ~${info.freePercent}% for ${Math.round(info.sustainedMs / 1000)}s — ` +
        'below the critical floor. Killing running commands before the machine swaps to death.',
    );
    this.logger.error(
      '   ↳ Reduce the workspace fan-out, lower max_concurrency, or disable phase-merge, then re-run.',
    );
    this.logger.error(
      '   ↳ To bypass this guard: re-run with --no-memory-guard (one run), set `memory_guard: false` in ' +
        'the config (off permanently), or relax the thresholds via ' +
        '`memory_guard: { abortFreeRatio, sustainedMs, minFreeRatio }` — lower abortFreeRatio/minFreeRatio ' +
        'and/or raise sustainedMs so brief dips no longer abort.',
    );
    this._appendEvent('run_aborted', { reason: 'memory_pressure', freePercent: info.freePercent });

    // Stop any further scheduling first so nothing new is dispatched while we tear down.
    this._stopPeriodicHook();
    this._stopActiveLogHint();
    this.memoryGovernor.stopWatchdog();

    // Best-effort: persist what completed so the report isn't lost, and mark the run ENDED — a
    // terminal write (top-level success=false) so the report and the aggregate's inProgress
    // auto-detection read the run as over rather than stuck RUNNING.
    try {
      this._writePartialResults(true);
    } catch {
      // ignore — we're aborting anyway
    }

    // Kill the heavy children first (the thing actually eating RAM), then run the normal cleanup for
    // any tracked background processes.
    try {
      this.processManager.killActiveForeground('SIGKILL');
    } catch (err) {
      this.logger.verbose(`[memory-guard] foreground kill failed: ${err.message}`);
    }
    try {
      await this.processManager.cleanup();
    } catch (err) {
      this.logger.verbose(`[memory-guard] cleanup failed: ${err.message}`);
    }

    this._clearRunState();
    // Force a static, non-refreshing roll-up so a memory-killed run doesn't linger as RUNNING.
    if (this.aggregateOptions) this._fireAggregate(false);
    process.exit(MEMORY_ABORT_EXIT_CODE);
  }

  // Stop scheduling further periodic ticks.
  _stopPeriodicHook() {
    if (this._periodicTimer) {
      clearInterval(this._periodicTimer);
      this._periodicTimer = null;
    }
  }

  // Final synchronous fire so the aggregate reflects the finished run before the process exits.
  _firePeriodicHookFinal() {
    // In-process aggregate path: the repo-root run owns the "run complete" signal, so it forces a
    // static (non-refresh) report. A fanned-out workspace run must NOT — the root run is still in
    // flight, so leave inProgress auto-detected from the (still-present) root run-state file.
    if (this.aggregateOptions && !this.periodicHook) {
      this._stopPeriodicHook();
      this._fireAggregate(this._isRepoRootRun() ? false : undefined);
      return;
    }
    if (!this.periodicHook) return;
    this._stopPeriodicHook();
    try {
      spawnSync(this.periodicHook, {
        shell: true,
        stdio: 'ignore',
        cwd: process.cwd(),
        env: { ...process.env, SCRIPTS_ORCHESTRATOR_PERIODIC: 'final' },
      });
    } catch (err) {
      this.logger.warn(`[periodic_hook] final invocation failed: ${err.message}`);
    }
  }

  // run user-configured post_run shell command
  _runPostRunHook(hasFailures) {
    if (!this.postRun) return;
    this.logger.info(`[post_run] ${this.postRun}`);
    const result = spawnSync(this.postRun, {
      shell: true,
      stdio: 'inherit',
      cwd: process.cwd(),
      env: {
        ...process.env,
        SCRIPTS_ORCHESTRATOR_SUCCESS: hasFailures ? '0' : '1',
        SCRIPTS_ORCHESTRATOR_EXIT_CODE: hasFailures ? '1' : '0',
      },
    });
    if (result.status !== 0) {
      this.logger.warn(`[post_run] hook exited with code ${result.status}`);
    }
  }
}
