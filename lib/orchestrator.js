import fs from 'fs';
import path from 'path';
import { spawn, spawnSync } from 'child_process';
import { processManager } from './process-manager.js';
import { healthCheck } from './health-check.js';
import { log } from './logger.js';
import { GitCache } from './git-cache.js';
import { renderReportHtml } from './report-html.js';
import { findRepoRoot, writeAggregateReport } from './workspaces.js';
import chalk from 'chalk';

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
    this.failedCommands = [];
    this.skippedCommands = [];
    this.skipReasons = new Map(); // Track why commands were skipped
    this.commandTimings = new Map(); // command -> { durationMs, memoryKb? }
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
    // post-run hook command (shell string)
    this.postRun = null; // set from config in index.js
    // Memory heat thresholds for the HTML report (fractions of the run's peak). Set from config in
    // index.js; embedded into the results payload so the renderer (and --render) honour them.
    this.memoryHeat = null;
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

  // atomically write current run state (completed + in-flight commands) to json_results
  _writePartialResults() {
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
      success: null, // in-progress sentinel; replaced by writeJsonResults on completion
      timestamp: new Date().toISOString(),
      ...(this.startTime ? { overallDurationMs: Date.now() - this.startTime } : {}), // elapsed so far
      commands,
      ...(this.config.phases && this.phaseResults.length > 0 ? { phases: this.phaseResults } : {}),
      ...(this.memoryHeat ? { memoryHeat: this.memoryHeat } : {}),
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
    } = commandConfig;

    const startTime = Date.now();
    // Effective invocation prefix for this command ('' => run verbatim as a shell command).
    const prefix = this._resolvePrefix(commandConfig);

    // Record the destination log file for this command (honors per-command override).
    // Done early so even disabled/skipped commands report where output would land.
    this.commandLogPaths.set(command, this.processManager.getLogPath(command, log || logFile));

    const setTiming = (durationMs, memoryKb = null) => {
      this.commandTimings.set(command, { durationMs, memoryKb });
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
        });
        setTiming(Date.now() - startTime);
        visited.delete(command);
        return true;
      }
    }

    // Execute dependencies first
    for (const dependency of dependencies) {
      const dependencySuccess = await this.executeCommand(dependency, visited);
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
        prefix,
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
    setTiming(totalDurationMs, lastRunResult?.memoryKb ?? null);
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
          const tasks = this.config.map((commandConfig) =>
            this.executeCommand(commandConfig),
          );
          const results = await Promise.all(tasks);
          hasFailures = results.some((result) => !result);
        }
      } else if (this.config.phases) {
        // New: Run phases sequentially, commands within phases in parallel or sequential based on flag
        if (this.sequential) {
          this.logger.info('🔄 Running in sequential mode');
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
                this.commandTimings.set(command, { durationMs: 0, memoryKb: null });
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
              this.commandTimings.set(command, { durationMs: 0, memoryKb: null });
            });
            continue;
          }

          if (phaseFailed) {
            // Mark all commands in remaining phases as skipped
            phase.parallel.forEach(({ command }) => {
              this.skippedCommands.push(command);
              this.skipReasons.set(command, 'after_phase_failure');
              this.commandTimings.set(command, { durationMs: 0, memoryKb: null });
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
            // Run commands in parallel
            const tasks = phase.parallel.map((commandConfig) =>
              this.executeCommand(commandConfig, new Set(), phase.name),
            );
            results = await Promise.all(tasks);
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

      // Stop periodic ticks on error.
      this._stopPeriodicHook();

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
