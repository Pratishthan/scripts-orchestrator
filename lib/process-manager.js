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
    this.logFolder = 'scripts-orchestrator-logs'; // Default log folder
  }

  setLogFolder(logFolder) {
    this.logFolder = logFolder;
    this.logger.verbose(`Log folder set to: ${logFolder}`);
  }

  getLogPath(command) {
    const baseDir = this.logFolder ? path.resolve(this.logFolder) : process.cwd();
    const LOGS_DIR = path.join(baseDir, 'scripts-orchestrator-logs');
    // Use only the first word of the command for the log filename
    const logName = command.split(/\s+/)[0];
    return path.join(LOGS_DIR, `${logName}.log`);
  }

  addBackgroundProcess({ command, url, startedByScript, process_tracking, kill_command }) {
    this.logger.verbose(`Adding background process: ${command} (${url})`);
    this.backgroundProcessesDetails.push({
      command,
      url,
      startedByScript,
      process_tracking,
      kill_command,
    });
  }

  async runCommand({ cmd, logFile, background = false, healthCheck = null, kill_command = null, isRetry = false, env = null }) {
    const baseDir = this.logFolder ? path.resolve(this.logFolder) : process.cwd();
    const LOGS_DIR = path.join(baseDir, 'scripts-orchestrator-logs');
    // Use only the first word of the command for the log filename
    const logName = cmd.split(/\s+/)[0];
    const LOG_FILE = logFile || path.join(LOGS_DIR, `${logName}.log`);

    try {
      if (!fs.existsSync(LOGS_DIR)) {
        this.logger.verbose(`Creating logs directory at ${LOGS_DIR}`);
        fs.mkdirSync(LOGS_DIR, { recursive: true });
      }

      if (!isRetry) {
        this.logger.verbose(`Clearing log file at ${LOG_FILE}`);
        fs.writeFileSync(LOG_FILE, ''); // Clear the log file
      } else {
        this.logger.verbose(`Appending to existing log file at ${LOG_FILE} (retry attempt)`);
      }
    } catch (error) {
      this.logger.error(`Failed to setup log file: ${error.message}`);
      return Promise.resolve({ success: false, output: '' });
    }

    return new Promise((resolve) => {
      // Build command with environment variables if provided
      let fullCommand = `npm run ${cmd}`;
      if (env && Object.keys(env).length > 0) {
        const envStr = Object.entries(env).map(([key, value]) => `${key}=${value}`).join(' ');
        fullCommand = `${envStr} npm run ${cmd}`;
      }
      
      this.logger.info(`Running: ${fullCommand}`);
      
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

        processInstance.on('error', (error) => {
          this.logger.error(`Failed to start process: ${error.message}`);
          //this.logger.verbose(`Process error details: ${JSON.stringify(error, null, 2)}`);
          resolve({ success: false, output: '' });
        });

        if (background) {
          const processGroupId = processInstance.pid;
          this.logger.verbose(`Background process spawned with PID: ${processGroupId}`);

          // Track process exit for background processes
          let processExited = false;
          let processExitCode = null;
          
          processInstance.on('exit', (code, signal) => {
            processExited = true;
            processExitCode = code;
            this.logger.verbose(`Background process ${cmd} (PID: ${processGroupId}) exited with code: ${code}, signal: ${signal}`);
          });

          processInstance.stdout.on('data', (data) => {
            try {
              fs.appendFileSync(LOG_FILE, data.toString());
            } catch (error) {
              this.logger.error(`Failed to write to log file: ${error.message}`);
            }
          });

          processInstance.stderr.on('data', (data) => {
            try {
              fs.appendFileSync(LOG_FILE, data.toString());
            } catch (error) {
              this.logger.error(`Failed to write to log file: ${error.message}`);
            }
          });

          const verifyProcess = async () => {
            const maxAttempts = 5;
            const baseDelay = 1000;

            for (let attempt = 1; attempt <= maxAttempts; attempt++) {
              try {
                // First check if the process has already exited with an error
                if (processExited && processExitCode !== 0) {
                  this.logger.error(`Background process ${cmd} exited with code ${processExitCode}`);
                  let output = '';
                  try {
                    output = fs.readFileSync(LOG_FILE, 'utf8');
                    this.logger.verbose(`Process output: ${output}`);
                  } catch (error) {
                    this.logger.error(`Failed to read log file: ${error.message}`);
                  }
                  return { success: false, output };
                }
                
                this.logger.verbose(`Verifying process ${processGroupId} (attempt ${attempt}/${maxAttempts})`);
                process.kill(processGroupId, 0);
                this.logger.verbose(`Process ${processGroupId} is running`);
                
                // Wait a bit more to ensure the process doesn't exit immediately after verification
                await new Promise((resolve) => setTimeout(resolve, 500));
                
                // Check again if the process exited during our wait
                if (processExited && processExitCode !== 0) {
                  this.logger.error(`Background process ${cmd} exited with code ${processExitCode} shortly after starting`);
                  let output = '';
                  try {
                    output = fs.readFileSync(LOG_FILE, 'utf8');
                    this.logger.verbose(`Process output: ${output}`);
                  } catch (error) {
                    this.logger.error(`Failed to read log file: ${error.message}`);
                  }
                  return { success: false, output };
                }
                
                this.backgroundProcesses.push(processGroupId);
                this.backgroundProcessesDetails.push({
                  command: cmd,
                  pgid: processGroupId,
                  startTime: Date.now(),
                  url: healthCheck?.url,
                  startedByScript: true,
                  kill_command,
                });
                
                this.logger.verbose(`Unreferencing process ${processGroupId}`);
                processInstance.unref();
                
                this.logger.verbose(
                  `Background process started: npm run ${cmd} (PGID: ${processGroupId})`,
                );
                return { success: true, output: '' };
              } catch (error) {
                if (attempt === maxAttempts) {
                  this.logger.error(`Failed to start background process: npm run ${cmd}`);
                  this.logger.verbose(`Final verification attempt failed: ${error.message}`);
                  return { success: false, output: '' };
                }
                this.logger.verbose(`Verification attempt ${attempt} failed: ${error.message}`);
                this.logger.verbose(`Waiting ${baseDelay * Math.pow(2, attempt - 1)}ms before next attempt`);
                await new Promise((resolve) =>
                  setTimeout(resolve, baseDelay * Math.pow(2, attempt - 1)),
                );
              }
            }
            return { success: false, output: '' };
          };

          verifyProcess().then(resolve);
        } else {
          processInstance.stdout.on('data', (data) => {
            try {
              fs.appendFileSync(LOG_FILE, data.toString());
            } catch (error) {
              this.logger.error(`Failed to write to log file: ${error.message}`);
            }
          });

          processInstance.stderr.on('data', (data) => {
            try {
              fs.appendFileSync(LOG_FILE, data.toString());
            } catch (error) {
              this.logger.error(`Failed to write to log file: ${error.message}`);
            }
          });

          processInstance.on('close', async (code) => {
            let output = '';
            try {
              output = fs.readFileSync(LOG_FILE, 'utf8');
            } catch (error) {
              this.logger.error(`Failed to read log file: ${error.message}`);
            }

            if (code !== 0) {
              this.logger.error(`Failed: npm run ${cmd} (exit code: ${code})`);
              this.logger.verbose(`Process output: ${output}`);
              resolve({ success: false, output });
            } else {
              this.logger.success(`Completed: npm run ${cmd}`);
              resolve({ success: true, output });
            }
          });
        }
      } catch (error) {
        this.logger.error(`Failed to spawn process: ${error.message}`);
        //this.logger.verbose(`Spawn error details: ${JSON.stringify(error, null, 2)}`);
        resolve({ success: false, output: '' });
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

  async cleanup() {
    try {
      this.logger.info('\nCleaning up background processes...');
    
      // Debug: Log the number of processes we're tracking
      this.logger.info(`- Found ${this.backgroundProcessesDetails.length} background processes to clean up`);
    
      // Debug: Log each process details
      this.backgroundProcessesDetails.forEach(({ command, pgid, url, startedByScript, kill_command }, index) => {
        this.logger.verbose(`- Process ${index + 1}: command=${command}, pgid=${pgid}, url=${url}, startedByScript=${startedByScript}, kill_command=${kill_command}`);
      });
    
      const killPromises = this.backgroundProcessesDetails.map(
        async ({ command, pgid, url, startedByScript, kill_command }) => {
          await this.cleanupProcess({ command, pgid, url, startedByScript, kill_command });
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
      ({ command }) => command === commandName
    );
    
    if (commandProcesses.length === 0) {
      this.logger.verbose(`- No background processes found for command: ${commandName}`);
      return;
    }
    
    this.logger.verbose(`- Found ${commandProcesses.length} background processes for command: ${commandName}`);
    
    const killPromises = commandProcesses.map(
      async ({ command, pgid, url, startedByScript, kill_command }) => {
        await this.cleanupProcess({ command, pgid, url, startedByScript, kill_command });
      }
    );

    await Promise.allSettled(killPromises);
    
    // Remove the cleaned up processes from our tracking arrays
    this.backgroundProcesses = this.backgroundProcesses.filter(pgid => 
      !commandProcesses.some(proc => proc.pgid === pgid)
    );
    this.backgroundProcessesDetails = this.backgroundProcessesDetails.filter(
      ({ command }) => command !== commandName
    );
  }

  async cleanupProcess({ command, pgid, url, startedByScript, kill_command }) {
    if (!startedByScript) {
      this.logger.verbose(
        `- Skipping cleanup for ${command} (${url}) as it was not started by this script`,
      );
      return;
    }

    this.logger.verbose(`- Processing cleanup for ${command} (kill_command: ${kill_command})`);

    // Try custom kill command first if specified
    if (kill_command) {
      try {
        this.logger.verbose(`- Using custom kill command: npm run ${kill_command}`);
        const result = await this.runCommand({ cmd: kill_command, logFile: null, background: false });
        if (result.success) {
          this.logger.verbose(`- Successfully killed ${command} using custom command`);
          return;
        } else {
          this.logger.verbose('- Custom kill command failed, falling back to process signals');
        }
      } catch (error) {
        this.logger.verbose(`- Custom kill command error: ${error.message}, falling back`);
      }
    } else {
      this.logger.verbose(`- No kill_command specified for ${command}, using process signals`);
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
          const killProcess = spawn('taskkill', ['/F', '/T', '/PID', pgid.toString()]);
          await new Promise((resolve) => {
            killProcess.on('close', resolve);
          });
          this.logger.verbose(`- Terminated background process: ${command} (PID: ${pgid})`);
          return;
        } catch (killError) {
          this.logger.verbose(`- Failed to use taskkill, falling back to process.kill: ${killError.message}`);
        }
      }
      
      // Unix/Linux/macOS or Windows fallback: Try SIGTERM first
      process.kill(pgid, 'SIGTERM');

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
      this.logger.verbose(`- Failed to terminate process group: ${error.message}`);
    }

    // Check if the URL is still responding after termination attempt
    if (url) {
      try {
        const urlObj = new URL(url);
        const port = urlObj.port || (urlObj.protocol === 'https:' ? '443' : '80');
        
        // Use shared HTTP utility for cross-platform compatibility
        const urlResult = await HealthCheck.makeHttpRequest(url, 2000);
        
        if (urlResult.success && urlResult.statusCode === 200) {
          this.logger.verbose(`- URL ${url} is still responding after termination, finding process on port ${port}`);
          
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
                  if (line.includes(`:${port} `) && line.includes('LISTENING')) {
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
                  this.logger.verbose(`- Killed process (PID: ${pid}) using port ${port}`);
                } catch (killError) {
                  if (killError.code !== 'ESRCH') {
                    this.logger.error(`- Failed to kill process (PID: ${pid}): ${killError.message}`);
                  }
                }
              }
            }
          } catch (portError) {
            this.logger.error(`- Failed to find process using port ${port}: ${portError.message}`);
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
        const killProcess = spawn('taskkill', ['/F', '/T', '/PID', pgid.toString()]);
        await new Promise((resolve) => {
          killProcess.on('close', resolve);
        });
      } else {
        // Unix/Linux/macOS: use SIGKILL
        process.kill(pgid, 'SIGKILL');
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