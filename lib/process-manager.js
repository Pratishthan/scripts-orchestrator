import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { log } from './logger.js';
import { HealthCheck } from './health-check.js';

export class ProcessManager {
  constructor() {
    this.logger = log;
    this.backgroundProcesses = [];
    this.backgroundProcessesDetails = [];
    // Live foreground (non-background) child processes, keyed by pid. These are the heavy gate
    // commands (build/test/type-check) — the things that actually consume host memory. We track them
    // so the memory-guard watchdog can kill them on a hard abort; background dev servers are tracked
    // separately in backgroundProcessesDetails and cleaned up via cleanup().
    this.activeForegroundProcesses = new Map(); // pid -> { cmd, processInstance }
    this.logFolder = 'scripts-orchestrator-logs'; // Default log folder
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

  setLogFolder(logFolder) {
    this.logFolder = logFolder;
    this.logger.verbose(`Log folder set to: ${logFolder}`);
  }

  getLogPath(command, logFileOverride = null) {
    // A per-command 'log'/'logFile' override wins, resolved against cwd.
    if (logFileOverride) return path.resolve(logFileOverride);
    const baseDir = this.logFolder
      ? path.resolve(this.logFolder)
      : process.cwd();
    const LOGS_DIR = path.join(baseDir, 'scripts-orchestrator-logs');
    // Use only the first word of the command for the log filename
    const logName = command.split(/\s+/)[0];
    return path.join(LOGS_DIR, `${logName}.log`);
  }

  addBackgroundProcess({
    command,
    url,
    startedByScript,
    process_tracking,
    kill_command,
    prefix = 'npm run',
    phase = null,
    persist = false,
  }) {
    this.logger.verbose(`Adding background process: ${command} (${url})`);
    this.backgroundProcessesDetails.push({
      command,
      url,
      startedByScript,
      process_tracking,
      kill_command,
      prefix,
      phase,
      persist,
    });
  }

  /** Read a `/usr/bin/time -v -o <file>` (GNU) output file once and delete it; returns its text or null. */
  readTimeFile(filePath) {
    try {
      if (!fs.existsSync(filePath)) return null;
      const text = fs.readFileSync(filePath, 'utf8');
      try {
        fs.unlinkSync(filePath);
      } catch {
        // ignore
      }
      return text;
    } catch {
      return null;
    }
  }

  /** Parse peak RSS (KB) from GNU `time -v` text; returns memory in KB or null. */
  parseGnuTimeMemory(text) {
    if (!text || typeof text !== 'string') return null;
    const m = text.match(/Maximum resident set size \(kbytes\):\s*(\d+)/i);
    const kbytes = m ? parseInt(m[1], 10) : null;
    return Number.isFinite(kbytes) ? kbytes : null;
  }

  /** Read+parse peak RSS (KB) from a GNU `time -v` output file (reads and deletes it). */
  parseGnuTimeOutput(filePath) {
    return this.parseGnuTimeMemory(this.readTimeFile(filePath));
  }

  /** Parse macOS BSD time -l output (bytes) from text; returns memory in KB or null. */
  parseBsdTimeOutput(text) {
    if (!text || typeof text !== 'string') return null;
    const m = text.match(/(\d+)\s+maximum resident set size/i);
    if (!m) return null;
    const bytes = parseInt(m[1], 10);
    return Number.isFinite(bytes) ? Math.round(bytes / 1024) : null;
  }

  /**
   * Parse user + system CPU seconds from GNU `time -v` text.
   * Returns { userSec, sysSec } or null when neither field is present.
   */
  parseGnuTimeCpu(text) {
    if (!text || typeof text !== 'string') return null;
    const u = text.match(/User time \(seconds\):\s*([\d.]+)/i);
    const s = text.match(/System time \(seconds\):\s*([\d.]+)/i);
    if (!u && !s) return null;
    const userSec = u ? parseFloat(u[1]) : 0;
    const sysSec = s ? parseFloat(s[1]) : 0;
    return { userSec: Number.isFinite(userSec) ? userSec : 0, sysSec: Number.isFinite(sysSec) ? sysSec : 0 };
  }

  /**
   * Parse user + system CPU seconds from macOS BSD `time -l` text
   * (e.g. `0.07 real  0.06 user  0.00 sys`). Returns { userSec, sysSec } or null.
   */
  parseBsdTimeCpu(text) {
    if (!text || typeof text !== 'string') return null;
    const u = text.match(/([\d.]+)\s+user\b/i);
    const s = text.match(/([\d.]+)\s+sys\b/i);
    if (!u && !s) return null;
    const userSec = u ? parseFloat(u[1]) : 0;
    const sysSec = s ? parseFloat(s[1]) : 0;
    return { userSec: Number.isFinite(userSec) ? userSec : 0, sysSec: Number.isFinite(sysSec) ? sysSec : 0 };
  }

  /**
   * Derive average CPU utilisation as a percentage from CPU seconds over wall-clock ms.
   * 100 = one core fully utilised for the whole duration; >100 = multiple cores on average.
   * Returns null when inputs are missing/zero-duration.
   */
  computeCpuPercent(cpu, durationMs) {
    if (!cpu || !Number.isFinite(durationMs) || durationMs <= 0) return null;
    const wallSec = durationMs / 1000;
    const pct = ((cpu.userSec + cpu.sysSec) / wallSec) * 100;
    return Number.isFinite(pct) ? Math.round(pct) : null;
  }

  async runCommand({
    cmd,
    logFile,
    background = false,
    healthCheck = null,
    kill_command = null,
    isRetry = false,
    env = null,
    reportTime = false,
    reportMemory = false,
    reportCpu = false,
    prefix = 'npm run',
    startPhase = null,
    persist = false,
  }) {
    // Resolve how the command is invoked. A non-empty prefix (e.g. 'npm run') is
    // prepended to the command name; an empty/false prefix runs the command verbatim
    // as a regular shell command. `displayCmd` is what we surface in logs.
    const commandPrefix = prefix ? String(prefix).trim() : '';
    const displayCmd = commandPrefix ? `${commandPrefix} ${cmd}` : cmd;
    const baseDir = this.logFolder
      ? path.resolve(this.logFolder)
      : process.cwd();
    const LOGS_DIR = path.join(baseDir, 'scripts-orchestrator-logs');
    // Use only the first word of the command for the log filename
    const logName = cmd.split(/\s+/)[0];
    // Single source of truth for the destination log path (honors per-command override).
    const LOG_FILE = this.getLogPath(cmd, logFile);

    try {
      if (!fs.existsSync(LOGS_DIR)) {
        this.logger.verbose(`Creating logs directory at ${LOGS_DIR}`);
        fs.mkdirSync(LOGS_DIR, { recursive: true });
      }

      if (!isRetry) {
        this.logger.verbose(`Clearing log file at ${LOG_FILE}`);
        fs.writeFileSync(LOG_FILE, ''); // Clear the log file
      } else {
        this.logger.verbose(
          `Appending to existing log file at ${LOG_FILE} (retry attempt)`,
        );
      }
    } catch (error) {
      this.logger.error(`Failed to setup log file: ${error.message}`);
      return Promise.resolve({
        success: false,
        output: '',
        durationMs: 0,
        memoryKb: null,
      });
    }

    // Point a tailing developer at this command's live output. Each command's stdout/stderr is
    // captured to its own file (not streamed to the console), so surfacing the path is the only way
    // to watch it live. Skip on retries — the hint was already shown when the command first started.
    if (!isRetry) {
      const relLog = path.relative(process.cwd(), LOG_FILE);
      this.logger.printMessage(() => console.log(`[INFO] Tail: ${relLog}`));
    }

    return new Promise((resolve) => {
      const startTime = Date.now();
      let timeOutputPath = null;
      // Build command with environment variables if provided
      let fullCommand = displayCmd;
      if (env && Object.keys(env).length > 0) {
        // On Windows, KEY=value command prefixes are invalid for cmd.exe. The spawn `env`
        // option (isolatedEnv below) already carries these values on every platform.
        if (process.platform !== 'win32') {
          const envStr = Object.entries(env)
            .map(([key, value]) => `${key}=${value}`)
            .join(' ');
          fullCommand = `${envStr} ${displayCmd}`;
        }
      }
      const useTimeWrapper =
        (reportMemory || reportCpu) && !background && (process.platform === 'linux' || process.platform === 'darwin');
      if (useTimeWrapper && process.platform === 'linux') {
        timeOutputPath = path.join(LOGS_DIR, `.time-${logName}-${startTime}.txt`);
        fullCommand = `/usr/bin/time -v -o ${JSON.stringify(timeOutputPath)} sh -c ${JSON.stringify(fullCommand)}`;
      } else if (useTimeWrapper && process.platform === 'darwin') {
        fullCommand = `/usr/bin/time -l sh -c ${JSON.stringify(fullCommand)}`;
      }

      this.logger.startTask(cmd, fullCommand);

      // Create isolated environment for each process
      const isolatedEnv = this.createIsolatedEnvironment({ command: cmd, env });

      const options = {
        shell: true,
        detached: background,
        stdio: ['ignore', 'pipe', 'pipe'],
        cwd: process.cwd(),
        env: isolatedEnv,
        windowsHide: true,
        ...(background ? { processGroup: true } : {}),
      };

      //this.logger.verbose(`Process options: ${JSON.stringify(options, null, 2)}`);

      try {
        this.logger.verbose(`Spawning process with command: ${fullCommand}`);
        const processInstance = spawn(fullCommand, [], options);

        // Register foreground (gate) commands so the memory-guard can kill them on a hard abort.
        if (!background && processInstance.pid) {
          this.activeForegroundProcesses.set(processInstance.pid, { cmd, processInstance });
        }

        processInstance.on('error', (error) => {
          if (!background && processInstance.pid) {
            this.activeForegroundProcesses.delete(processInstance.pid);
          }
          this.logger.stopTask(cmd);
          this.logger.error(`Failed to start process: ${error.message}`);
          resolve({
            success: false,
            output: '',
            durationMs: Date.now() - startTime,
            memoryKb: null,
          });
        });

        if (background) {
          const processGroupId = processInstance.pid;
          this.logger.verbose(
            `Background process spawned with PID: ${processGroupId}`,
          );

          // Track process exit for background processes
          let processExited = false;
          let processExitCode = null;

          processInstance.on('exit', (code, signal) => {
            processExited = true;
            processExitCode = code;
            this.logger.verbose(
              `Background process ${cmd} (PID: ${processGroupId}) exited with code: ${code}, signal: ${signal}`,
            );
          });

          processInstance.stdout.on('data', (data) => {
            try {
              fs.appendFileSync(LOG_FILE, data.toString());
            } catch (error) {
              this.logger.error(
                `Failed to write to log file: ${error.message}`,
              );
            }
          });

          processInstance.stderr.on('data', (data) => {
            try {
              fs.appendFileSync(LOG_FILE, data.toString());
            } catch (error) {
              this.logger.error(
                `Failed to write to log file: ${error.message}`,
              );
            }
          });

          const verifyProcess = async () => {
            const maxAttempts = 5;
            const baseDelay = 1000;

            for (let attempt = 1; attempt <= maxAttempts; attempt++) {
              try {
                // First check if the process has already exited with an error
                if (processExited && processExitCode !== 0) {
                  this.logger.stopTask(cmd);
                  this.logger.error(
                    `Background process ${cmd} exited with code ${processExitCode}`,
                  );
                  let output = '';
                  try {
                    output = fs.readFileSync(LOG_FILE, 'utf8');
                    this.logger.verbose(`Process output: ${output}`);
                  } catch (error) {
                    this.logger.error(
                      `Failed to read log file: ${error.message}`,
                    );
                  }
                  return {
                    success: false,
                    output,
                    durationMs: Date.now() - startTime,
                    memoryKb: null,
                  };
                }

                this.logger.verbose(
                  `Verifying process ${processGroupId} (attempt ${attempt}/${maxAttempts})`,
                );
                process.kill(processGroupId, 0);
                this.logger.verbose(`Process ${processGroupId} is running`);

                // Wait a bit more to ensure the process doesn't exit immediately after verification
                await new Promise((resolve) => setTimeout(resolve, 500));

                // Check again if the process exited during our wait
                if (processExited && processExitCode !== 0) {
                  this.logger.stopTask(cmd);
                  this.logger.error(
                    `Background process ${cmd} exited with code ${processExitCode} shortly after starting`,
                  );
                  let output = '';
                  try {
                    output = fs.readFileSync(LOG_FILE, 'utf8');
                    this.logger.verbose(`Process output: ${output}`);
                  } catch (error) {
                    this.logger.error(
                      `Failed to read log file: ${error.message}`,
                    );
                  }
                  return {
                    success: false,
                    output,
                    durationMs: Date.now() - startTime,
                    memoryKb: null,
                  };
                }

                this.backgroundProcesses.push(processGroupId);
                this.backgroundProcessesDetails.push({
                  command: cmd,
                  pgid: processGroupId,
                  startTime: Date.now(),
                  url: healthCheck?.url,
                  startedByScript: true,
                  kill_command,
                  prefix: commandPrefix,
                  // The phase that started this background process and whether it must outlive
                  // that phase. Used by cleanupPhase() to tear down phase-scoped dependencies
                  // (e.g. a `npm run dev` server) as soon as their phase ends, while a process
                  // marked persist:true survives until the whole run finishes.
                  phase: startPhase,
                  persist,
                });

                this.logger.verbose(`Unreferencing process ${processGroupId}`);
                processInstance.unref();

                this.logger.stopTask(cmd);
                this.logger.verbose(
                  `Background process started: ${displayCmd} (PGID: ${processGroupId})`,
                );
                return {
                  success: true,
                  output: '',
                  durationMs: Date.now() - startTime,
                  memoryKb: null,
                };
              } catch (error) {
                if (attempt === maxAttempts) {
                  this.logger.error(
                    `Failed to start background process: ${displayCmd}`,
                  );
                  this.logger.verbose(
                    `Final verification attempt failed: ${error.message}`,
                  );
                  return {
                    success: false,
                    output: '',
                    durationMs: Date.now() - startTime,
                    memoryKb: null,
                  };
                }
                this.logger.verbose(
                  `Verification attempt ${attempt} failed: ${error.message}`,
                );
                this.logger.verbose(
                  `Waiting ${baseDelay * Math.pow(2, attempt - 1)}ms before next attempt`,
                );
                await new Promise((resolve) =>
                  setTimeout(resolve, baseDelay * Math.pow(2, attempt - 1)),
                );
              }
            }
            return {
              success: false,
              output: '',
              durationMs: Date.now() - startTime,
              memoryKb: null,
            };
          };

          verifyProcess().then(resolve);
        } else {
          processInstance.stdout.on('data', (data) => {
            try {
              fs.appendFileSync(LOG_FILE, data.toString());
            } catch (error) {
              this.logger.error(
                `Failed to write to log file: ${error.message}`,
              );
            }
          });

          processInstance.stderr.on('data', (data) => {
            try {
              fs.appendFileSync(LOG_FILE, data.toString());
            } catch (error) {
              this.logger.error(
                `Failed to write to log file: ${error.message}`,
              );
            }
          });

          processInstance.on('close', async (code) => {
            if (processInstance.pid) {
              this.activeForegroundProcesses.delete(processInstance.pid);
            }
            let output = '';
            try {
              output = fs.readFileSync(LOG_FILE, 'utf8');
            } catch (error) {
              this.logger.error(`Failed to read log file: ${error.message}`);
            }

            this.logger.stopTask(cmd);

            const durationMs = Date.now() - startTime;
            const durationStr = reportTime
              ? ` (${this.formatDuration(durationMs)})`
              : '';
            let memoryKb = null;
            let cpuPercent = null;
            if (reportMemory || reportCpu) {
              // Both metrics are parsed from the same /usr/bin/time output, so read it once.
              let cpu = null;
              if (timeOutputPath) {
                const timeText = this.readTimeFile(timeOutputPath);
                if (reportMemory) memoryKb = this.parseGnuTimeMemory(timeText);
                if (reportCpu) cpu = this.parseGnuTimeCpu(timeText);
              } else if (process.platform === 'darwin') {
                if (reportMemory) memoryKb = this.parseBsdTimeOutput(output);
                if (reportCpu) cpu = this.parseBsdTimeCpu(output);
              }
              if (reportCpu) cpuPercent = this.computeCpuPercent(cpu, durationMs);
            }

            if (code !== 0) {
              this.logger.error(
                `Failed: ${displayCmd} ❌${durationStr} (exit code: ${code})`,
              );
              this.logger.verbose(`Process output: ${output}`);
              resolve({
                success: false,
                output,
                durationMs,
                memoryKb,
                cpuPercent,
              });
            } else {
              this.logger.success(`Completed: ${displayCmd} ✅${durationStr}`);
              resolve({
                success: true,
                output,
                durationMs,
                memoryKb,
                cpuPercent,
              });
            }
          });
        }
      } catch (error) {
        this.logger.stopTask(cmd);
        this.logger.error(`Failed to spawn process: ${error.message}`);
        resolve({
          success: false,
          output: '',
          durationMs: Date.now() - startTime,
          memoryKb: null,
        });
      }
    });
  }

  createIsolatedEnvironment({ command, env = null }) {
    // Create a deep copy to avoid any reference sharing
    const baseEnv = JSON.parse(JSON.stringify(process.env));

    // Set standard environment variables
    const isolatedEnv = {
      ...baseEnv,
      NODE_ENV: process.env.NODE_ENV || 'development',
      // Add command-specific environment isolation
      SCRIPTS_ORCHESTRATOR_COMMAND: command,
      SCRIPTS_ORCHESTRATOR_PID: process.pid.toString(),
      // Force fresh PATH to avoid any dynamic modifications
      PATH: process.env.PATH,
      // Ensure npm/node paths are isolated
      npm_config_cache: path.join(process.cwd(), 'node_modules/.cache/npm'),
      // Prevent npm from sharing config between parallel processes
      npm_config_progress: 'false',
      npm_config_loglevel: 'error',
    };

    // Merge custom environment variables if provided
    if (env && typeof env === 'object') {
      Object.entries(env).forEach(([key, value]) => {
        isolatedEnv[key] = String(value);
      });
    }

    // Remove any potentially problematic environment variables
    delete isolatedEnv.npm_lifecycle_event;
    delete isolatedEnv.npm_lifecycle_script;

    return isolatedEnv;
  }

  /**
   * Kill every tracked foreground (gate) command immediately. Used by the memory-guard hard abort to
   * stop the host swapping to death. Sends the signal to each child's process group when it is its
   * own leader (so the whole toolchain tree dies, not just the `sh -c` wrapper) and falls back to the
   * bare pid otherwise. SIGKILL is uncatchable, so a wedged toolchain can't ignore it. Synchronous and
   * best-effort: this runs on the way to process.exit, so it must never throw or block.
   */
  killActiveForeground(signal = 'SIGKILL') {
    const entries = Array.from(this.activeForegroundProcesses.values());
    if (entries.length === 0) return;
    this.logger.warn(`- Killing ${entries.length} running command(s) to relieve memory pressure...`);
    for (const { cmd, processInstance } of entries) {
      const pid = processInstance?.pid;
      if (!pid) continue;
      // Try the process group first (negative pid). Harmless if the child isn't a group leader —
      // it throws ESRCH/EPERM, which we ignore and fall back to the bare pid below.
      if (process.platform !== 'win32') {
        try {
          process.kill(-pid, signal);
        } catch {
          // not a group leader (or already gone) — fall through to the direct kill
        }
      }
      try {
        process.kill(pid, signal);
      } catch (error) {
        if (error.code !== 'ESRCH') {
          this.logger.verbose(`- Failed to kill ${cmd} (pid ${pid}): ${error.message}`);
        }
      }
    }
    this.activeForegroundProcesses.clear();
  }

  async cleanup() {
    try {
      this.logger.info('\nCleaning up background processes...');

      // Debug: Log the number of processes we're tracking
      this.logger.info(
        `- Found ${this.backgroundProcessesDetails.length} background processes to clean up`,
      );

      // Debug: Log each process details
      this.backgroundProcessesDetails.forEach(
        ({ command, pgid, url, startedByScript, kill_command }, index) => {
          this.logger.verbose(
            `- Process ${index + 1}: command=${command}, pgid=${pgid}, url=${url}, startedByScript=${startedByScript}, kill_command=${kill_command}`,
          );
        },
      );

      const killPromises = this.backgroundProcessesDetails.map(
        async ({ command, pgid, url, startedByScript, kill_command }) => {
          await this.cleanupProcess({
            command,
            pgid,
            url,
            startedByScript,
            kill_command,
          });
        },
      );

      await Promise.allSettled(killPromises);
      this.backgroundProcesses = [];
      this.backgroundProcessesDetails = [];
    } catch (error) {
      this.logger.error(`Cleanup failed: ${error.message}`);
    }
  }

  async cleanupCommand(commandName) {
    this.logger.info(`\nCleaning up processes for command: ${commandName}`);

    // Find processes for this specific command
    const commandProcesses = this.backgroundProcessesDetails.filter(
      ({ command }) => command === commandName,
    );

    if (commandProcesses.length === 0) {
      this.logger.verbose(
        `- No background processes found for command: ${commandName}`,
      );
      return;
    }

    this.logger.verbose(
      `- Found ${commandProcesses.length} background processes for command: ${commandName}`,
    );

    const killPromises = commandProcesses.map(
      async ({ command, pgid, url, startedByScript, kill_command, prefix }) => {
        await this.cleanupProcess({
          command,
          pgid,
          url,
          startedByScript,
          kill_command,
          prefix,
        });
      },
    );

    await Promise.allSettled(killPromises);

    // Remove the cleaned up processes from our tracking arrays
    this.backgroundProcesses = this.backgroundProcesses.filter(
      (pgid) => !commandProcesses.some((proc) => proc.pgid === pgid),
    );
    this.backgroundProcessesDetails = this.backgroundProcessesDetails.filter(
      ({ command }) => command !== commandName,
    );
  }

  /**
   * Tear down every background process started during `phaseName`, unless it was marked
   * `persist: true` (a process explicitly declared to outlive its phase — e.g. a shared dev
   * server that several later phases run against). Called at the end of each phase, on both
   * success and failure, so phase-scoped dependencies like a `npm run dev` server don't leak
   * past the phase that started them. Best-effort and idempotent: a process already gone is a
   * no-op, and cleaned-up entries are removed from the tracking arrays so the final run-end
   * cleanup() doesn't try them again.
   */
  async cleanupPhase(phaseName) {
    const phaseProcesses = this.backgroundProcessesDetails.filter(
      (proc) => proc.phase === phaseName && !proc.persist,
    );

    if (phaseProcesses.length === 0) {
      this.logger.verbose(
        `- No phase-scoped background processes to clean up for phase: ${phaseName}`,
      );
      return;
    }

    this.logger.info(
      `\nCleaning up ${phaseProcesses.length} background process(es) started in phase: ${phaseName}`,
    );

    const killPromises = phaseProcesses.map(
      async ({ command, pgid, url, startedByScript, kill_command, prefix }) => {
        await this.cleanupProcess({
          command,
          pgid,
          url,
          startedByScript,
          kill_command,
          prefix,
        });
      },
    );

    await Promise.allSettled(killPromises);

    // Drop the cleaned-up processes from tracking so run-end cleanup() skips them.
    const cleanedPgids = new Set(phaseProcesses.map((proc) => proc.pgid));
    this.backgroundProcesses = this.backgroundProcesses.filter(
      (pgid) => !cleanedPgids.has(pgid),
    );
    this.backgroundProcessesDetails = this.backgroundProcessesDetails.filter(
      (proc) => !(proc.phase === phaseName && !proc.persist),
    );
  }

  /**
   * Signal a background child's whole process group, falling back to the bare pid.
   *
   * Background commands are spawned detached (`detached: true`), so the child is its own process
   * group leader and its pid == pgid. `npm run dev` then fans out (`sh -c` → npm → node/vite), and
   * signalling only the positive pid hits the `sh`/npm wrapper while the actual dev server keeps
   * running and holding its port. Signalling the negative pgid delivers to the entire tree so the
   * server actually dies. The positive-pid fallback covers the rare case where the child isn't a
   * group leader. Returns true if either signal was delivered.
   */
  killProcessGroup(pgid, signal) {
    let delivered = false;
    if (process.platform !== 'win32') {
      try {
        process.kill(-pgid, signal);
        delivered = true;
      } catch (error) {
        // Not a group leader (or already gone) — fall through to the bare pid.
        if (error.code !== 'ESRCH' && error.code !== 'EPERM') {
          this.logger.verbose(`- Group signal ${signal} to -${pgid} failed: ${error.message}`);
        }
      }
    }
    try {
      process.kill(pgid, signal);
      delivered = true;
    } catch (error) {
      if (error.code !== 'ESRCH') {
        this.logger.verbose(`- Signal ${signal} to ${pgid} failed: ${error.message}`);
      }
    }
    return delivered;
  }

  async cleanupProcess({ command, pgid, url, startedByScript, kill_command, prefix = 'npm run' }) {
    if (!startedByScript) {
      this.logger.verbose(
        `- Skipping cleanup for ${command} (${url}) as it was not started by this script`,
      );
      return;
    }

    this.logger.verbose(
      `- Processing cleanup for ${command} (kill_command: ${kill_command})`,
    );

    // Try custom kill command first if specified
    if (kill_command) {
      try {
        const killDisplay = prefix ? `${String(prefix).trim()} ${kill_command}` : kill_command;
        this.logger.verbose(
          `- Using custom kill command: ${killDisplay}`,
        );
        const result = await this.runCommand({
          cmd: kill_command,
          logFile: null,
          background: false,
          prefix,
        });
        if (result.success) {
          this.logger.verbose(
            `- Successfully killed ${command} using custom command`,
          );
          return;
        } else {
          this.logger.verbose(
            '- Custom kill command failed, falling back to process signals',
          );
        }
      } catch (error) {
        this.logger.verbose(
          `- Custom kill command error: ${error.message}, falling back`,
        );
      }
    } else {
      this.logger.verbose(
        `- No kill_command specified for ${command}, using process signals`,
      );
    }

    try {
      // First try to kill the process group
      try {
        process.kill(pgid, 0);
      } catch (error) {
        this.logger.verbose(
          `- Process ${command} (PGID: ${pgid}) already terminated`,
        );
        return;
      }

      // Cross-platform process termination
      const isWindows = process.platform === 'win32';

      if (isWindows) {
        // Windows: use taskkill to terminate process tree
        try {
          const killProcess = spawn('taskkill', [
            '/F',
            '/T',
            '/PID',
            pgid.toString(),
          ]);
          await new Promise((resolve) => {
            killProcess.on('close', resolve);
          });
          this.logger.verbose(
            `- Terminated background process: ${command} (PID: ${pgid})`,
          );
          return;
        } catch (killError) {
          this.logger.verbose(
            `- Failed to use taskkill, falling back to process.kill: ${killError.message}`,
          );
        }
      }

      // Unix/Linux/macOS or Windows fallback: Try SIGTERM first. Signal the whole process group
      // (negative pgid) so the dev server's children die too, not just the `sh`/npm wrapper.
      this.killProcessGroup(pgid, 'SIGTERM');

      await new Promise((resolve, reject) => {
        let timeout, checkInterval;

        timeout = setTimeout(() => {
          if (checkInterval) clearInterval(checkInterval);
          reject(new Error('Process termination timeout'));
        }, 5000);

        checkInterval = setInterval(() => {
          try {
            process.kill(pgid, 0);
          } catch (error) {
            if (checkInterval) clearInterval(checkInterval);
            if (timeout) clearTimeout(timeout);
            resolve();
          }
        }, 100);
      });
      this.logger.verbose(
        `- Terminated background process: ${command} (PGID: ${pgid})`,
      );
    } catch (error) {
      this.logger.verbose(
        `- Failed to terminate process group: ${error.message}`,
      );
    }

    // Check if the URL is still responding after termination attempt
    if (url) {
      try {
        const urlObj = new URL(url);
        const port =
          urlObj.port || (urlObj.protocol === 'https:' ? '443' : '80');

        // Use shared HTTP utility for cross-platform compatibility
        const urlResult = await HealthCheck.makeHttpRequest(url, 2000);

        if (urlResult.success && urlResult.statusCode === 200) {
          this.logger.verbose(
            `- URL ${url} is still responding after termination, finding process on port ${port}`,
          );

          // Find and kill process using the port - cross-platform approach
          try {
            const isWindows = process.platform === 'win32';
            let findPortCmd, findPortArgs;

            if (isWindows) {
              // Windows: use netstat
              findPortCmd = 'netstat';
              findPortArgs = ['-ano'];
            } else {
              // Unix/Linux/macOS: use lsof
              findPortCmd = 'lsof';
              findPortArgs = ['-i', `:${port}`, '-t'];
            }

            const findProcess = spawn(findPortCmd, findPortArgs);
            const result = await new Promise((resolve) => {
              let output = '';
              findProcess.stdout.on('data', (data) => {
                output += data.toString();
              });
              findProcess.on('close', (code) => {
                resolve({ code, output });
              });
            });

            if (result.code === 0 && result.output.trim()) {
              let pids = [];

              if (isWindows) {
                // Parse netstat output to find PIDs for the specific port
                const lines = result.output.split('\n');
                for (const line of lines) {
                  if (
                    line.includes(`:${port} `) &&
                    line.includes('LISTENING')
                  ) {
                    const parts = line.trim().split(/\s+/);
                    const pid = parts[parts.length - 1];
                    if (pid && !isNaN(pid)) {
                      pids.push(pid);
                    }
                  }
                }
              } else {
                // lsof output is already just PIDs
                pids = result.output.trim().split('\n');
              }

              for (const pid of pids) {
                try {
                  if (isWindows) {
                    // Windows: use taskkill
                    const killProcess = spawn('taskkill', ['/F', '/PID', pid]);
                    await new Promise((resolve) => {
                      killProcess.on('close', resolve);
                    });
                  } else {
                    // Unix/Linux/macOS: use process.kill
                    process.kill(parseInt(pid), 'SIGKILL');
                  }
                  this.logger.verbose(
                    `- Killed process (PID: ${pid}) using port ${port}`,
                  );
                } catch (killError) {
                  if (killError.code !== 'ESRCH') {
                    this.logger.error(
                      `- Failed to kill process (PID: ${pid}): ${killError.message}`,
                    );
                  }
                }
              }
            }
          } catch (portError) {
            this.logger.error(
              `- Failed to find process using port ${port}: ${portError.message}`,
            );
          }
        }
      } catch (error) {
        this.logger.verbose(`- URL check failed: ${error.message}`);
      }
    }

    // Final attempt to kill the process group
    try {
      const isWindows = process.platform === 'win32';

      if (isWindows) {
        // Windows: force kill with taskkill
        const killProcess = spawn('taskkill', [
          '/F',
          '/T',
          '/PID',
          pgid.toString(),
        ]);
        await new Promise((resolve) => {
          killProcess.on('close', resolve);
        });
      } else {
        // Unix/Linux/macOS: SIGKILL the whole process group (negative pgid) as a last resort,
        // so an unresponsive dev server tree is force-killed rather than left orphaned.
        this.killProcessGroup(pgid, 'SIGKILL');
      }
    } catch (error) {
      if (error.code !== 'ESRCH') {
        this.logger.error(`- Failed to kill process group: ${error.message}`);
      }
    }
  }
}

// For backward compatibility
export const processManager = new ProcessManager();
