import chalk from 'chalk';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

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
  .option('logFolder', {
    type: 'string',
    description: 'Specify the directory for log files',
  })
  .parse();

class Logger {
  constructor() {
    this.isVerbose = argv.verbose;
  }

  info(message) {
    console.log(chalk.blue(`[INFO] ${message}`));
  }

  success(message) {
    console.log(chalk.green(`[SUCCESS] ${message}`));
  }

  error(message) {
    console.error(chalk.red(`[ERROR] ${message}`));
  }

  warn(message) {
    console.warn(chalk.yellow(`[WARN] ${message}`));
  }

  verbose(message) {
    if (this.isVerbose) {
      console.log(chalk.gray(`[VERBOSE] ${message}`));
    }
  }
}

// Create a single instance
const logger = new Logger();

// Export both the class and the instance
export { Logger, logger as log }; 