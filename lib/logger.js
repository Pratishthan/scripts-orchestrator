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
    this.initializeLogFile();
  }

  initializeLogFile() {
    try {
      // Create log directory if it doesn't exist
      if (!fs.existsSync(this.logFolder)) {
        fs.mkdirSync(this.logFolder, { recursive: true });
      }

      // Create main log file with timestamp
      const timestamp = new Date().toISOString().replace(/:/g, '-').replace(/\..+/, '');
      this.logFile = path.join(this.logFolder, `orchestrator-main-${timestamp}.log`);
      
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
      this.writeToFile(`[START] Orchestrator started at ${new Date().toISOString()}\n`);
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
    console.log(chalk.blue(`[INFO] ${message}`));
    this.writeToFile(`[INFO] ${message}`);
  }

  success(message) {
    console.log(chalk.green(`[SUCCESS] ${message}`));
    this.writeToFile(`[SUCCESS] ${message}`);
  }

  error(message) {
    console.error(chalk.red(`[ERROR] ${message}`));
    this.writeToFile(`[ERROR] ${message}`);
  }

  warn(message) {
    console.warn(chalk.yellow(`[WARN] ${message}`));
    this.writeToFile(`[WARN] ${message}`);
  }

  verbose(message) {
    if (this.isVerbose) {
      console.log(chalk.gray(`[VERBOSE] ${message}`));
      this.writeToFile(`[VERBOSE] ${message}`);
    }
  }
}

// Create a single instance
const logger = new Logger();

// Export both the class and the instance
export { Logger, logger as log }; 