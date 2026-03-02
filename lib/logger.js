import chalk from 'chalk';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import fs from 'fs';
import path from 'path';

const argv = yargs(hideBin(process.argv))
  .option('verbose', {
    alias: 'v',
    type: 'boolean',
    description: 'Run with verbose logging',
  })
  .option('phase', {
    type: 'string',
    description: 'Start execution from a specific phase',
  })
  .option('phases', {
    type: 'string',
    description: 'Comma-separated list of phases to run (for optional phases)',
  })
  .option('logFolder', {
    type: 'string',
    description: 'Specify the directory for log files',
  })
  .parse();

class Logger {
  constructor() {
    this.isVerbose = argv.verbose;
    this.logFolder = argv.logFolder || 'scripts-orchestrator-logs';
    this.logFile = null;
    this.logStream = null;

    // For TTY dynamic output
    this.isTTY = process.stdout.isTTY;
    this.activeTasks = new Map();
    this.linesRendered = 0;

    this.initializeLogFile();
  }

  // --- Dynamic Output Handling ---

  clearActiveTasks() {
    if (!this.isTTY || this.linesRendered === 0) return;
    // Move cursor up and clear lines
    for (let i = 0; i < this.linesRendered; i++) {
      process.stdout.write('\x1b[1A\x1b[2K'); // Up one line, clear entire line
    }
    this.linesRendered = 0;
  }

  renderActiveTasks() {
    if (!this.isTTY) return;
    if (this.activeTasks.size === 0) return;

    // Render active tasks with a spinner or prefix
    for (const [, text] of this.activeTasks) {
      process.stdout.write(`${text}\n`);
      this.linesRendered++;
    }
  }

  startTask(id, text) {
    if (this.isTTY) {
      this.clearActiveTasks();
      this.activeTasks.set(id, chalk.cyan(`[INFO] ⏳ Running: ${text}`));
      this.renderActiveTasks();
    } else {
      this.info(`Running: ${text}`);
    }
  }

  updateTask(id, text) {
    if (this.isTTY && this.activeTasks.has(id)) {
      this.clearActiveTasks();
      this.activeTasks.set(id, chalk.cyan(`[INFO] ⏳ Running: ${text}`));
      this.renderActiveTasks();
    }
  }

  stopTask(id) {
    if (this.isTTY && this.activeTasks.has(id)) {
      this.clearActiveTasks();
      this.activeTasks.delete(id);
      this.renderActiveTasks();
    }
  }

  // --- Wrapper for output methods ---

  printMessage(logFn) {
    if (this.isTTY) {
      this.clearActiveTasks();
      logFn();
      this.renderActiveTasks();
    } else {
      logFn();
    }
  }

  startEphemeral(id, message) {
    if (this.isTTY) {
      this.clearActiveTasks();
      this.activeTasks.set(id, message);
      this.renderActiveTasks();
    } else {
      this.printMessage(() => console.log(message));
    }
  }

  stopEphemeral(id, finalMessage = '', isError = false) {
    if (this.isTTY && this.activeTasks.has(id)) {
      this.clearActiveTasks();
      this.activeTasks.delete(id);
      this.renderActiveTasks();
    }

    if (finalMessage) {
      if (isError) {
        this.printMessage(() =>
          console.error(chalk.red(`[ERROR] ${finalMessage}`)),
        );
      } else {
        this.printMessage(() =>
          console.log(chalk.green(`[SUCCESS] ${finalMessage}`)),
        );
      }
    }
  }

  stopPhase(phaseName, success, durationStr) {
    if (success) {
      this.printMessage(() =>
        console.log(
          chalk.green(
            `[SUCCESS] ✅ Phase "${phaseName}" completed successfully ${durationStr}`,
          ),
        ),
      );
      // Add a blank line after phase logs for readability
      this.printMessage(() => console.log(''));
      this.writeToFile('');
    } else {
      this.printMessage(() =>
        console.error(
          chalk.red(
            `[ERROR] ❌ Phase "${phaseName}" completed with failures ${durationStr}`,
          ),
        ),
      );
      // Add a blank line after phase logs for readability
      this.printMessage(() => console.log(''));
      this.writeToFile('');
    }
  }

  initializeLogFile() {
    try {
      // Create log directory if it doesn't exist
      if (!fs.existsSync(this.logFolder)) {
        fs.mkdirSync(this.logFolder, { recursive: true });
      }

      // Create main log file with timestamp
      const timestamp = new Date()
        .toISOString()
        .replace(/:/g, '-')
        .replace(/\..+/, '');
      this.logFile = path.join(
        this.logFolder,
        `orchestrator-main-${timestamp}.log`,
      );

      // Create write stream
      this.logStream = fs.createWriteStream(this.logFile, { flags: 'a' });

      // Handle stream errors
      this.logStream.on('error', (err) => {
        console.error(`Error writing to log file: ${err.message}`);
      });

      // Ensure the stream is closed on process exit
      process.on('exit', () => {
        if (this.logStream) {
          this.logStream.end();
        }
      });

      // Write initial log entry
      this.writeToFile(
        `[START] Orchestrator started at ${new Date().toISOString()}\n`,
      );
    } catch (error) {
      console.error(`Failed to initialize log file: ${error.message}`);
    }
  }

  setLogFolder(newLogFolder) {
    // Close existing stream if it exists
    if (this.logStream) {
      this.logStream.end();
    }

    // Update log folder
    this.logFolder = newLogFolder;

    // Reinitialize with new folder
    this.initializeLogFile();
  }

  writeToFile(message) {
    if (this.logStream) {
      // Strip ANSI color codes for file output
      // eslint-disable-next-line no-control-regex
      const cleanMessage = message.replace(/\x1b\[[0-9;]*m/g, '');
      this.logStream.write(`${cleanMessage}\n`);
    }
  }

  info(message) {
    this.printMessage(() => console.log(chalk.blue(`[INFO] ${message}`)));
    this.writeToFile(`[INFO] ${message}`);
  }

  success(message) {
    this.printMessage(() => console.log(chalk.green(`[SUCCESS] ${message}`)));
    this.writeToFile(`[SUCCESS] ${message}`);
  }

  error(message) {
    this.printMessage(() => console.error(chalk.red(`[ERROR] ${message}`)));
    this.writeToFile(`[ERROR] ${message}`);
  }

  warn(message) {
    this.printMessage(() => console.warn(chalk.yellow(`[WARN] ${message}`)));
    this.writeToFile(`[WARN] ${message}`);
  }

  verbose(message) {
    if (this.isVerbose) {
      this.printMessage(() => console.log(chalk.gray(`[VERBOSE] ${message}`)));
      this.writeToFile(`[VERBOSE] ${message}`);
    }
  }
}

// Create a single instance
const logger = new Logger();

// Export both the class and the instance
export { Logger, logger as log };
