import fs from 'fs';
import { processManager } from './process-manager.js';
import { healthCheck } from './health-check.js';
import { log } from './logger.js';
import { GitCache } from './git-cache.js';
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
    this.jsonResultsPath = jsonResultsPath ?? null;
    this.htmlResultsPath = htmlResultsPath ?? null;
    this.processManager = processManager;
    this.healthCheck = healthCheck;
    this.logger = log;
    this.failedCommands = [];
    this.skippedCommands = [];
    this.skipReasons = new Map(); // Track why commands were skipped
    this.commandTimings = new Map(); // command -> { durationMs, memoryKb? }
    this.phaseResults = []; // { name, success, durationMs } per phase run
    this.gitCache = new GitCache(logFolder);

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

  async executeCommand(commandConfig, visited = new Set()) {
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
      this.logger.warn(`Skipping: npm run ${command} (status: disabled)`);
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
    const overallDurationMs =
      this.metrics.includes('time') && this.startTime
        ? Date.now() - this.startTime
        : undefined;

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
          ...(timing?.durationMs != null && this.metrics.includes('time')
            ? { durationMs: timing.durationMs }
            : {}),
          ...(this.metrics.includes('memory')
            ? { memoryKb: timing?.memoryKb ?? null }
            : {}),
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
            ...(timing?.durationMs != null && this.metrics.includes('time')
              ? { durationMs: timing.durationMs }
              : {}),
            ...(this.metrics.includes('memory')
              ? { memoryKb: timing?.memoryKb ?? null }
              : {}),
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
  }

  formatMs(ms) {
    if (ms == null || ms === 0) return '—';
    if (ms < 1000) return `${ms}ms`;
    const s = (ms / 1000).toFixed(1);
    return `${s}s`;
  }

  writeHtmlResults(payload) {
    const escapeHtml = (s) => {
      if (s == null) return '';
      return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    };
    const { success, timestamp, overallDurationMs, commands = [], phases = [] } = payload;
    const maxDuration = Math.max(0, ...commands.map((c) => c.durationMs || 0), ...phases.map((p) => p.durationMs || 0));
    const maxMemory = Math.max(0, ...commands.map((c) => c.memoryKb || 0));

    const row = (c) => {
      const durationPct = maxDuration > 0 && c.durationMs != null ? (c.durationMs / maxDuration) * 100 : 0;
      const memoryPct = maxMemory > 0 && c.memoryKb != null ? (c.memoryKb / maxMemory) * 100 : 0;
      const statusClass = c.success ? 'ok' : 'fail';
      const statusLabel = c.success ? 'OK' : (c.skipReason || 'Failed');
      return `
        <tr class="${statusClass}">
          <td><code>${escapeHtml(c.command)}</code></td>
          <td>${c.phase != null ? escapeHtml(c.phase) : '—'}</td>
          <td><span class="badge ${statusClass}">${escapeHtml(statusLabel)}</span></td>
          <td>${this.formatMs(c.durationMs)}</td>
          <td>${c.memoryKb != null ? `${(c.memoryKb / 1024).toFixed(1)} MB` : '—'}</td>
          <td class="bar-cell"><div class="bar" style="width:${durationPct}%"></div></td>
          <td class="bar-cell"><div class="bar mem" style="width:${memoryPct}%"></div></td>
        </tr>`;
    };

    const phaseRow = (p) => {
      const durationPct = maxDuration > 0 && p.durationMs != null ? (p.durationMs / maxDuration) * 100 : 0;
      const statusClass = p.success ? 'ok' : 'fail';
      return `
        <tr class="${statusClass}">
          <td>${escapeHtml(p.name)}</td>
          <td><span class="badge ${statusClass}">${p.success ? 'OK' : 'Failed'}</span></td>
          <td>${this.formatMs(p.durationMs)}</td>
          <td class="bar-cell"><div class="bar" style="width:${durationPct}%"></div></td>
        </tr>`;
    };

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Scripts Orchestrator Report</title>
  <style>
    * { box-sizing: border-box; }
    body { font-family: system-ui, sans-serif; margin: 1rem 2rem; background: #1a1a1a; color: #e0e0e0; }
    h1 { font-size: 1.5rem; margin-bottom: 0.5rem; }
    .summary { display: flex; gap: 1.5rem; flex-wrap: wrap; margin-bottom: 1.5rem; }
    .summary .card { background: #2a2a2a; padding: 1rem 1.25rem; border-radius: 8px; min-width: 140px; }
    .summary .card.success { border-left: 4px solid #22c55e; }
    .summary .card.fail { border-left: 4px solid #ef4444; }
    .summary .label { font-size: 0.75rem; text-transform: uppercase; color: #888; }
    .summary .value { font-size: 1.25rem; font-weight: 600; }
    section { margin-bottom: 1.5rem; }
    section h2 { font-size: 1.1rem; color: #a0a0a0; margin-bottom: 0.5rem; }
    table { width: 100%; border-collapse: collapse; background: #2a2a2a; border-radius: 8px; overflow: hidden; }
    th, td { padding: 0.5rem 0.75rem; text-align: left; }
    th { background: #333; color: #888; font-weight: 600; font-size: 0.8rem; }
    tr.fail { background: rgba(239,68,68,0.08); }
    .badge { padding: 0.2rem 0.5rem; border-radius: 4px; font-size: 0.8rem; }
    .badge.ok { background: #22c55e; color: #0f0f0f; }
    .badge.fail { background: #ef4444; color: #fff; }
    .bar-cell { width: 120px; }
    .bar { height: 8px; background: #3b82f6; border-radius: 4px; min-width: 2px; }
    .bar.mem { background: #8b5cf6; }
    code { font-size: 0.9em; background: #333; padding: 0.1rem 0.3rem; border-radius: 4px; }
  </style>
</head>
<body>
  <h1>Scripts Orchestrator Report</h1>
  <div class="summary">
    <div class="card ${success ? 'success' : 'fail'}">
      <div class="label">Status</div>
      <div class="value">${success ? 'Success' : 'Failed'}</div>
    </div>
    <div class="card">
      <div class="label">Timestamp</div>
      <div class="value" style="font-size:0.9rem">${escapeHtml(timestamp)}</div>
    </div>
    ${overallDurationMs != null ? `
    <div class="card">
      <div class="label">Total time</div>
      <div class="value">${this.formatMs(overallDurationMs)}</div>
    </div>` : ''}
  </div>

  ${phases.length > 0 ? `
  <section>
    <h2>Phases</h2>
    <table>
      <thead><tr><th>Phase</th><th>Status</th><th>Duration</th><th></th></tr></thead>
      <tbody>${phases.map(phaseRow).join('')}</tbody>
    </table>
  </section>` : ''}

  <section>
    <h2>Commands</h2>
    <table>
      <thead><tr><th>Command</th><th>Phase</th><th>Status</th><th>Duration</th><th>Memory</th><th>Time</th><th>Memory</th></tr></thead>
      <tbody>${commands.map(row).join('')}</tbody>
    </table>
  </section>
</body>
</html>`;

    if (this.htmlResultsPath === '-') {
      console.log(html);
    } else {
      const outPath = this.htmlResultsPath || './scripts-orchestrator-results.html';
      fs.writeFileSync(outPath, html, 'utf8');
      this.logger.verbose(`Wrote HTML report to ${outPath}`);
    }
  }

  async run() {
    this.startTime = Date.now();
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
              const result = await this.executeCommand(commandConfig);
              results.push(result);
              if (!result) {
                // In sequential mode, stop phase execution on first failure
                break;
              }
            }
          } else {
            // Run commands in parallel
            const tasks = phase.parallel.map((commandConfig) =>
              this.executeCommand(commandConfig),
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
            durationMs: this.metrics.includes('time') ? phaseDurationMs : undefined,
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

      // Write JSON results if requested
      if (this.jsonResultsPath != null) {
        this.writeJsonResults(hasFailures);
      }

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

      // Cleanup on error
      try {
        await this.processManager.cleanup();
      } catch (cleanupError) {
        this.logger.error(`Cleanup failed: ${cleanupError.message}`);
      }

      process.exit(1);
    }
  }
}
