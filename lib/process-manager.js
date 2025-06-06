import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { log } from './logger.js';


export class ProcessManager {
  constructor() {
    this.logger = log;
    this.backgroundProcesses = [];
    this.backgroundProcessesDetails = [];
  }

  addBackgroundProcess({ command, url, startedByScript, process_tracking }) {
    this.logger.verbose(`Adding background process: ${command} (${url})`);
    this.backgroundProcessesDetails.push({
      command,
      url,
      startedByScript,
      process_tracking,
    });
  }

  async runCommand(cmd, logFile, background = false, healthCheck = null) {
    const LOGS_DIR = path.resolve(process.cwd(), 'scripts-orchestrator-logs');
    const LOG_FILE = logFile || path.join(LOGS_DIR, `${cmd}.log`);

    try {
      if (!fs.existsSync(LOGS_DIR)) {
        this.logger.verbose(`Creating logs directory at ${LOGS_DIR}`);
        fs.mkdirSync(LOGS_DIR, { recursive: true });
      }

      this.logger.verbose(`Clearing log file at ${LOG_FILE}`);
      fs.writeFileSync(LOG_FILE, ''); // Clear the log file
    } catch (error) {
      this.logger.error(`Failed to setup log file: ${error.message}`);
      return Promise.resolve({ success: false, output: '' });
    }

    return new Promise((resolve) => {
      this.logger.info(`Running: npm run ${cmd}`);
      
      // Create isolated environment for each process
      const isolatedEnv = this.createIsolatedEnvironment(cmd);
      
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
        this.logger.verbose(`Spawning process with command: npm run ${cmd}`);
        const processInstance = spawn('npm', ['run', cmd], options);

        processInstance.on('error', (error) => {
          this.logger.error(`Failed to start process: ${error.message}`);
          //this.logger.verbose(`Process error details: ${JSON.stringify(error, null, 2)}`);
          resolve({ success: false, output: '' });
        });

        if (background) {
          const processGroupId = processInstance.pid;
          this.logger.verbose(`Background process spawned with PID: ${processGroupId}`);

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
                this.logger.verbose(`Verifying process ${processGroupId} (attempt ${attempt}/${maxAttempts})`);
                process.kill(processGroupId, 0);
                this.logger.verbose(`Process ${processGroupId} is running`);
                
                this.backgroundProcesses.push(processGroupId);
                this.backgroundProcessesDetails.push({
                  command: cmd,
                  pgid: processGroupId,
                  startTime: Date.now(),
                  url: healthCheck?.url,
                  startedByScript: true,
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

  createIsolatedEnvironment(command) {
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

    // Remove any potentially problematic environment variables
    delete isolatedEnv.npm_lifecycle_event;
    delete isolatedEnv.npm_lifecycle_script;
    
    return isolatedEnv;
  }

  async cleanup() {
    this.logger.info('\nCleaning up background processes...');
    const killPromises = this.backgroundProcessesDetails.map(
      async ({ command, pgid, url, startedByScript }) => {
        if (!startedByScript) {
          this.logger.verbose(
            `- Skipping cleanup for ${command} (${url}) as it was not started by this script`,
          );
          return;
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

          // Try SIGTERM first
          process.kill(pgid, 'SIGTERM');

          await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
              clearInterval(checkInterval);
              reject(new Error('Process termination timeout'));
            }, 5000);

            const checkInterval = setInterval(() => {
              try {
                process.kill(pgid, 0);
              } catch (error) {
                clearInterval(checkInterval);
                clearTimeout(timeout);
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
            
            const curl = spawn('curl', ['-s', '-o', '/dev/null', '-w', '%{http_code}', url]);
            const result = await new Promise((resolve) => {
              let output = '';
              curl.stdout.on('data', (data) => {
                output += data.toString();
              });
              curl.on('close', (code) => {
                resolve({ code, output });
              });
            });

            if (result.code === 0 && result.output === '200') {
              this.logger.verbose(`- URL ${url} is still responding after termination, finding process on port ${port}`);
              
              // Find and kill process using the port
              try {
                const lsof = spawn('lsof', ['-i', `:${port}`, '-t']);
                const result = await new Promise((resolve) => {
                  let output = '';
                  lsof.stdout.on('data', (data) => {
                    output += data.toString();
                  });
                  lsof.on('close', (code) => {
                    resolve({ code, output });
                  });
                });

                if (result.code === 0 && result.output.trim()) {
                  const pids = result.output.trim().split('\n');
                  for (const pid of pids) {
                    try {
                      process.kill(parseInt(pid), 'SIGKILL');
                      this.logger.verbose(`- Killed process (PID: ${pid}) using port ${port}`);
                    } catch (killError) {
                      if (killError.code !== 'ESRCH') {
                        this.logger.error(`- Failed to kill process (PID: ${pid}): ${killError.message}`);
                      }
                    }
                  }
                }
              } catch (lsofError) {
                this.logger.error(`- Failed to find process using port ${port}: ${lsofError.message}`);
              }
            }
          } catch (error) {
            this.logger.verbose(`- URL check failed: ${error.message}`);
          }
        }

        // Final attempt to kill the process group with SIGKILL
        try {
          process.kill(pgid, 'SIGKILL');
        } catch (error) {
          if (error.code !== 'ESRCH') {
            this.logger.error(`- Failed to kill process group with SIGKILL: ${error.message}`);
          }
        }
      },
    );

    await Promise.all(killPromises);
    this.backgroundProcesses = [];
    this.backgroundProcessesDetails = [];
  }
}

// For backward compatibility
export const processManager = new ProcessManager(); 