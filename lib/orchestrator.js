import { processManager } from './process-manager.js';
import { healthCheck } from './health-check.js';
import { log } from './logger.js';
import { GitCache } from './git-cache.js';

export class Orchestrator {
  constructor(config, startPhase = null, logFolder = null, phases = null, sequential = false) {
    this.config = config;
    this.startPhase = startPhase;
    this.logFolder = logFolder;
    this.phases = phases;
    this.sequential = sequential;
    this.processManager = processManager;
    this.healthCheck = healthCheck;
    this.logger = log;
    this.failedCommands = [];
    this.skippedCommands = [];
    this.commandTimings = new Map();
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
      return config.phases.flatMap(phase => phase.parallel || []);
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

    // Check for circular dependencies
    if (visited.has(command)) {
      this.logger.error(
        `Circular dependency detected: ${Array.from(visited).join(' -> ')} -> ${command}`,
      );
      this.failedCommands.push(command);
      this.commandTimings.set(command, Date.now() - startTime);
      return false;
    }
    visited.add(command);

    // Skip execution if the command is disabled
    if (status === 'disabled') {
      this.logger.warn(`Skipping: npm run ${command} (status: disabled)`);
      this.skippedCommands.push(command);
      this.commandTimings.set(command, Date.now() - startTime);
      visited.delete(command);
      return true;
    }

    const checkUrl = health_check?.url;
    if (checkUrl) {
      this.logger.info(`Checking if ${checkUrl} is already available...`);
      const urlAvailable = await this.healthCheck.waitForUrl({url: checkUrl, maxAttempts: 1, silent:true});
      if (urlAvailable) {
        this.logger.verbose(`${checkUrl} is already available. Skipping ${command} start.`);
        this.processManager.addBackgroundProcess({
          command,
          url: checkUrl,
          startedByScript: false,
          process_tracking,
          kill_command,
        });
        this.commandTimings.set(command, Date.now() - startTime);
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
        this.commandTimings.set(command, Date.now() - startTime);
        visited.delete(command);
        return false;
      }

      if (dependency.health_check?.url) {
        this.logger.info(`Waiting for ${dependency.health_check.url} to be available...`);
        const urlAvailable = await this.healthCheck.waitForUrl({
          url: dependency.health_check.url,
          maxAttempts: dependency.health_check?.max_attempts || 20,
          interval: dependency.health_check?.interval || 2000,
        });
        if (!urlAvailable) {
          this.logger.error(
            `URL ${dependency.health_check.url} is not available after maximum attempts`,
          );
          this.skippedCommands.push(command);
          this.commandTimings.set(command, Date.now() - startTime);
          visited.delete(command);
          return false;
        }
        if (dependency.wait) {
          this.logger.verbose(`Waiting ${dependency.wait}ms`);
          await new Promise((resolve) => {
            setTimeout(() => {
              this.logger.verbose(`Resolving after a wait of ${dependency.wait}ms`);
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
    
    for (let attempt = 1; attempt <= attempts; attempt++) {
      if (attempt > 1) {
        this.logger.warn(`Retrying ${command} (attempt ${attempt}/${attempts})`);
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }

      const { success, output } = await this.processManager.runCommand({
        cmd: attempt === 1 ? command : retry_command || command,
        logFile: log || logFile, // Prefer 'log' key over 'logFile' for backwards compatibility
        background,
        healthCheck: health_check,
        kill_command,
        isRetry: attempt > 1,
        env,
      });
      commandOutput = output;
      result = success;

      if (result) {
        // Remove from failed commands if it was there
        this.failedCommands = this.failedCommands.filter(cmd => cmd !== command);
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
        this.logger.error(`Attempt ${attempt}/${attempts} failed for ${command}`);
        commandFailed = true;
      } else {
        commandFailed = true;
      }
    }

    if (commandFailed) {
      this.failedCommands.push(command);
      
      // Cleanup any background processes for this failed command
      if (background) {
        this.logger.warn(`Command ${command} failed after all attempts. Cleaning up background processes.`);
        try {
          await this.processManager.cleanupCommand(command);
        } catch (cleanupError) {
          this.logger.error(`Failed to cleanup processes for ${command}: ${cleanupError.message}`);
        }
      }
    }

    this.commandTimings.set(command, Date.now() - startTime);
    visited.delete(command);
    return result;
  }

  summarizeResults() {
    this.logger.info('\nCommand Summary:');
    let hasFailures = false;
    
    this.allCommands.forEach(({ command }) => {
      const duration = this.commandTimings.get(command);
      const durationStr = duration ? ` (${this.formatDuration(duration)})` : '';
      
      if (this.failedCommands.includes(command)) {
        hasFailures = true;
        // Get the actual log path from process manager
        const logPath = this.processManager.getLogPath(command);
        this.logger.error(`- ${command}: ❌${durationStr} (See ${logPath})`);
      } else if (this.skippedCommands.includes(command)) {
        hasFailures = true;
        this.logger.warn(`- ${command}: ⚠️${durationStr} (Skipped due to failed dependency)`);
      } else {
        this.logger.success(`- ${command}: ✅${durationStr}`);
      }
    });

    if (hasFailures) {
      this.logger.error('\n❌ Some commands failed or were skipped. See details above.');
    } else {
      this.logger.success('\n🎉 All commands executed successfully!');
    }
  }

  async run() {
    try {
      // Check if we should skip execution based on git state
      const shouldSkip = await this.gitCache.shouldSkipExecution();
      if (shouldSkip) {
        this.logger.success('🎉 No changes detected, skipping execution!');
        process.exit(0);
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
          hasFailures = results.some(result => !result);
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
                this.commandTimings.set(command, 0);
              });
              continue;
            }
          }

          // Check if this is an optional phase that should be skipped
          if (phase.optional === true && this.phases && !this.phases.includes(phase.name)) {
            this.logger.info(`\n⏭️  Skipping optional phase: ${phase.name} (not explicitly requested)`);
            // Mark all commands in this phase as skipped
            phase.parallel.forEach(({ command }) => {
              this.skippedCommands.push(command);
              this.commandTimings.set(command, 0);
            });
            continue;
          }

          if (phaseFailed) {
            // Mark all commands in remaining phases as skipped
            phase.parallel.forEach(({ command }) => {
              this.skippedCommands.push(command);
              this.commandTimings.set(command, 0);
            });
            continue;
          }

          this.logger.info(`\n🔄 Starting phase: ${phase.name}`);
          
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
          
          const phaseHasFailures = results.some(result => !result);
          
          if (phaseHasFailures) {
            hasFailures = true;
            phaseFailed = true;
            this.logger.error(`❌ Phase "${phase.name}" completed with failures`);
          } else {
            this.logger.success(`✅ Phase "${phase.name}" completed successfully`);
          }
        }
      }

      // Validate start phase if specified
      if (this.startPhase && !startPhaseFound) {
        const availablePhases = this.config.phases.map(p => p.name).join(', ');
        this.logger.error(`❌ Start phase "${this.startPhase}" not found. Available phases: ${availablePhases}`);
        process.exit(1);
      }

      // Validate phases if specified
      if (this.phases) {
        const availablePhases = this.config.phases.map(p => p.name);
        const invalidPhases = this.phases.filter(phase => !availablePhases.includes(phase));
        if (invalidPhases.length > 0) {
          this.logger.error(`❌ Invalid phases specified: ${invalidPhases.join(', ')}. Available phases: ${availablePhases.join(', ')}`);
          process.exit(1);
        }
      }

      // Check final status
      hasFailures = hasFailures || 
                   this.failedCommands.length > 0 || 
                   this.skippedCommands.length > 0;

      // Add a small delay to ensure all processes have finished
      await new Promise((resolve) => setTimeout(resolve, 1000));

      this.summarizeResults();
      
      // Cleanup before exit since finally blocks don't run after process.exit()
      try {
        await this.processManager.cleanup();
      } catch (error) {
        this.logger.error(`Cleanup failed: ${error.message}`);
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